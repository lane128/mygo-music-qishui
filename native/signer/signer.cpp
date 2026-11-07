// One-request host ONLY for the immutable official 3.7.0 bdms.node.
// No engine, GC, prototype chain, accessors, asynchronous work or general N-API
// compatibility. Values/references survive until finalizers finish and exit.
#define NAPI_VERSION 8
#include <node_api.h>
#include <algorithm>
#include <array>
#include <cstdio>
#include <cstdlib>
#include <cstring>
#include <cstdint>
#include <csignal>
#include <map>
#include <memory>
#include <string>
#include <vector>
#ifdef _WIN32
#define WIN32_LEAN_AND_MEAN
#include <windows.h>
#include <fcntl.h>
#include <io.h>
#define FD_DUP _dup
#define FD_DUP2 _dup2
#define FD_CLOSE _close
#define FD_WRITE _write
#else
#include <dlfcn.h>
#include <mach-o/dyld.h>
#include <unistd.h>
#include <fcntl.h>
#define FD_DUP dup
#define FD_DUP2 dup2
#define FD_CLOSE close
#define FD_WRITE write
#endif

namespace {
constexpr size_t kInput = 131072, kString = 131072, kOutput = 65536;
constexpr size_t kSlots = 256, kProperties = 256, kArenaBytes = 1024 * 1024;
}
struct napi_value__ {
  napi_valuetype type = napi_undefined;
  std::string text;
  std::map<std::string, napi_value> properties;
  napi_callback callback = nullptr;
  void* data = nullptr;
};
struct napi_ref__ { napi_value value; bool alive = true; };
struct napi_handle_scope__ { bool alive = true; };
struct napi_callback_info__ {
  std::vector<napi_value> args; napi_value receiver; void* data;
};
struct Finalizer { node_api_basic_finalize callback; void* data; void* hint; };
struct napi_env__ {
  std::vector<std::unique_ptr<napi_value__>> values;
  std::vector<std::unique_ptr<napi_ref__>> references;
  std::vector<std::unique_ptr<napi_handle_scope__>> scopes;
  std::vector<napi_handle_scope> openScopes;
  std::vector<Finalizer> finalizers;
  napi_callback_info active = nullptr;
  napi_value pending = nullptr, undefined = nullptr;
  napi_extended_error_info error = {"signer N-API failure", nullptr, 0, napi_ok};
  size_t bytes = 0;
  bool failed = false, finalizing = false;
};
namespace {
static napi_status status(napi_env e, napi_status s) { if (e) e->error.error_code = s; return s; }
static napi_status failure(napi_env e) { if (e) e->failed = true; return status(e, napi_generic_failure); }
template<class T, class U> static bool owns(const std::vector<std::unique_ptr<T>>& list, U* item) {
  for (const auto& p : list) if (p.get() == item) return true;
  return false;
}
static bool valid(napi_env e, napi_value v) { return e && owns(e->values, v); }
static bool object(napi_env e, napi_value v) { return valid(e,v) && (v->type == napi_object || v->type == napi_function); }
static bool string(napi_env e, napi_value v) { return valid(e,v) && v->type == napi_string; }
static bool reserve(napi_env e, size_t bytes) {
  if (bytes > kArenaBytes - e->bytes) { e->failed = true; return false; }
  e->bytes += bytes; return true;
}
static napi_value value(napi_env e, napi_valuetype type) {
  if (e->values.size() >= kSlots) { e->failed = true; return nullptr; }
  auto p = std::make_unique<napi_value__>(); p->type = type;
  auto result = p.get(); e->values.push_back(std::move(p)); return result;
}
static bool utf8(const std::string& s) {
  for (size_t i = 0; i < s.size();) {
    uint32_t c = static_cast<unsigned char>(s[i++]);
    if (c < 0x80) continue;
    size_t n; uint32_t minimum;
    if (c >= 0xc2 && c <= 0xdf) { n=1; c &= 31; minimum=0x80; }
    else if (c >= 0xe0 && c <= 0xef) { n=2; c &= 15; minimum=0x800; }
    else if (c >= 0xf0 && c <= 0xf4) { n=3; c &= 7; minimum=0x10000; }
    else return false;
    if (n > s.size()-i) return false;
    while (n--) { auto b=static_cast<unsigned char>(s[i++]); if ((b&0xc0)!=0x80) return false; c=(c<<6)|(b&63); }
    if (c < minimum || c > 0x10ffff || (c>=0xd800 && c<=0xdfff)) return false;
  }
  return true;
}
static size_t boundedLength(const char* s) { size_t n=0; while(n<=kString && s[n]) ++n; return n; }
static napi_status property(napi_env e, napi_value obj, const std::string& key, napi_value v) {
  if (!object(e,obj)) return status(e,napi_object_expected);
  if (!valid(e,v) || key.size()>kString) return status(e,napi_invalid_arg);
  if (!obj->properties.count(key)) {
    if (obj->properties.size()>=kProperties || !reserve(e,key.size())) return failure(e);
  }
  obj->properties[key]=v; return status(e,napi_ok);
}
// Every exported status API contains allocation exceptions inside the C ABI.
#define API_BEGIN(e) if (!(e)) return napi_invalid_arg; try {
#define API_END(e) } catch (...) { return failure(e); }
#define REQUIRE_RUNNING(e) if ((e)->pending) return status(e,napi_pending_exception)
}
extern "C" {
NAPI_EXTERN napi_status NAPI_CDECL napi_get_last_error_info(node_api_basic_env e, const napi_extended_error_info** out) {
  API_BEGIN(e) if (!out) return status(e,napi_invalid_arg); *out=&e->error; return napi_ok; API_END(e)
}
NAPI_EXTERN napi_status NAPI_CDECL napi_get_undefined(napi_env e, napi_value* out) {
  API_BEGIN(e) if (!out) return status(e,napi_invalid_arg); *out=e->undefined; return status(e,napi_ok); API_END(e)
}
NAPI_EXTERN napi_status NAPI_CDECL napi_create_object(napi_env e, napi_value* out) {
  API_BEGIN(e) REQUIRE_RUNNING(e); if (!out) return status(e,napi_invalid_arg);
  *out=value(e,napi_object); return *out?status(e,napi_ok):failure(e); API_END(e)
}
NAPI_EXTERN napi_status NAPI_CDECL napi_create_string_utf8(napi_env e, const char* str, size_t length, napi_value* out) {
  API_BEGIN(e) REQUIRE_RUNNING(e); if (!str || !out) return status(e,napi_invalid_arg);
  if (length==NAPI_AUTO_LENGTH) length=boundedLength(str);
  if (length>kString || !reserve(e,length)) return failure(e);
  std::string text(str,length); if (!utf8(text)) return status(e,napi_invalid_arg);
  *out=value(e,napi_string); if (!*out) return failure(e);
  (*out)->text=std::move(text); return status(e,napi_ok); API_END(e)
}
NAPI_EXTERN napi_status NAPI_CDECL napi_typeof(napi_env e, napi_value v, napi_valuetype* out) {
  API_BEGIN(e) REQUIRE_RUNNING(e); if (!valid(e,v) || !out) return status(e,napi_invalid_arg);
  *out=v->type; return status(e,napi_ok); API_END(e)
}
NAPI_EXTERN napi_status NAPI_CDECL napi_get_value_string_utf8(napi_env e, napi_value v, char* buf, size_t size, size_t* out) {
  API_BEGIN(e) REQUIRE_RUNNING(e); if (!valid(e,v)) return status(e,napi_invalid_arg);
  if (!string(e,v)) return status(e,napi_string_expected);
  if (!buf && !out) return status(e,napi_invalid_arg);
  size_t count=buf?(size?std::min(v->text.size(),size-1):0):v->text.size();
  if (buf && count<v->text.size()) while(count && (static_cast<unsigned char>(v->text[count])&0xc0)==0x80) --count;
  if (buf && size) { memcpy(buf,v->text.data(),count); buf[count]=0; }
  if (out) *out=count; return status(e,napi_ok); API_END(e)
}
NAPI_EXTERN napi_status NAPI_CDECL napi_set_property(napi_env e, napi_value obj, napi_value key, napi_value v) {
  API_BEGIN(e) REQUIRE_RUNNING(e); if (!string(e,key)) return status(e,napi_name_expected);
  return property(e,obj,key->text,v); API_END(e)
}
NAPI_EXTERN napi_status NAPI_CDECL napi_has_property(napi_env e, napi_value obj, napi_value key, bool* out) {
  API_BEGIN(e) REQUIRE_RUNNING(e); if (!object(e,obj)) return status(e,napi_object_expected);
  if (!string(e,key) || !out) return status(e,napi_invalid_arg);
  *out=obj->properties.count(key->text)!=0; return status(e,napi_ok); API_END(e)
}
NAPI_EXTERN napi_status NAPI_CDECL napi_get_property(napi_env e, napi_value obj, napi_value key, napi_value* out) {
  API_BEGIN(e) REQUIRE_RUNNING(e); if (!object(e,obj)) return status(e,napi_object_expected);
  if (!string(e,key) || !out) return status(e,napi_invalid_arg);
  auto it=obj->properties.find(key->text); *out=it==obj->properties.end()?e->undefined:it->second; return status(e,napi_ok); API_END(e)
}
NAPI_EXTERN napi_status NAPI_CDECL napi_get_named_property(napi_env e, napi_value obj, const char* key, napi_value* out) {
  API_BEGIN(e) REQUIRE_RUNNING(e); if (!object(e,obj)) return status(e,napi_object_expected);
  if (!key || !out || boundedLength(key)>kString) return status(e,napi_invalid_arg);
  auto it=obj->properties.find(key); *out=it==obj->properties.end()?e->undefined:it->second; return status(e,napi_ok); API_END(e)
}
NAPI_EXTERN napi_status NAPI_CDECL napi_create_function(napi_env e, const char* name, size_t length, napi_callback cb, void* data, napi_value* out) {
  API_BEGIN(e) REQUIRE_RUNNING(e); if (!cb || !out) return status(e,napi_invalid_arg);
  if (name && (length==NAPI_AUTO_LENGTH?boundedLength(name):length)>kString) return status(e,napi_invalid_arg);
  *out=value(e,napi_function); if (!*out) return failure(e);
  (*out)->callback=cb; (*out)->data=data; return status(e,napi_ok); API_END(e)
}
NAPI_EXTERN napi_status NAPI_CDECL napi_define_properties(napi_env e, napi_value obj, size_t count, const napi_property_descriptor* props) {
  API_BEGIN(e) REQUIRE_RUNNING(e); if (!object(e,obj)) return status(e,napi_object_expected);
  if (count>kProperties || (count && !props)) return status(e,napi_invalid_arg);
  for (size_t i=0;i<count;++i) {
    const auto& p=props[i];
    // Descriptor flags cannot be honored by this plain-property subset. The SDK
    // path uses create_function/set_property. Reject rather than emulate them.
    if (p.getter || p.setter || p.attributes!=napi_default || (p.method && p.value)) return failure(e);
    if ((!p.utf8name && !string(e,p.name)) || (p.utf8name && boundedLength(p.utf8name)>kString)) return status(e,napi_invalid_arg);
    napi_value v=p.value;
    if (p.method) { auto s=napi_create_function(e,nullptr,0,p.method,p.data,&v); if (s!=napi_ok) return s; }
    auto s=property(e,obj,p.utf8name?std::string(p.utf8name):p.name->text,v); if (s!=napi_ok) return s;
  }
  return status(e,napi_ok); API_END(e)
}
NAPI_EXTERN napi_status NAPI_CDECL napi_get_cb_info(napi_env e, napi_callback_info info, size_t* argc, napi_value* argv, napi_value* receiver, void** data) {
  API_BEGIN(e) if (!info || info!=e->active || (argv && !argc)) return status(e,napi_invalid_arg);
  if (argc) {
    size_t capacity=*argc;
    // Only SDK callbacks with <=2 arguments are invoked. Bound caller capacity.
    if (argv && capacity>kSlots) return status(e,napi_invalid_arg);
    if (argv) for(size_t i=0;i<capacity;++i) argv[i]=i<info->args.size()?info->args[i]:e->undefined;
    *argc=info->args.size();
  }
  if (receiver) *receiver=info->receiver; if (data) *data=info->data;
  return status(e,napi_ok); API_END(e)
}
NAPI_EXTERN napi_status NAPI_CDECL napi_create_reference(napi_env e, napi_value v, uint32_t initial, napi_ref* out) {
  API_BEGIN(e) REQUIRE_RUNNING(e); if (!object(e,v) || !out) return status(e,napi_invalid_arg);
  // 0/1 refs are retained until exit; no weak collection occurs in this arena.
  if (initial>1) return failure(e);
  if (e->references.size()>=kSlots) return failure(e);
  auto p=std::make_unique<napi_ref__>(); p->value=v; *out=p.get(); e->references.push_back(std::move(p)); return status(e,napi_ok); API_END(e)
}
NAPI_EXTERN napi_status NAPI_CDECL napi_delete_reference(node_api_basic_env e, napi_ref ref) {
  API_BEGIN(e) if (!owns(e->references,ref) || !ref->alive) return status(e,napi_invalid_arg);
  ref->alive=false; return status(e,napi_ok); API_END(e)
}
NAPI_EXTERN napi_status NAPI_CDECL napi_get_reference_value(napi_env e, napi_ref ref, napi_value* out) {
  API_BEGIN(e) REQUIRE_RUNNING(e); if (!owns(e->references,ref) || !ref->alive || !out) return status(e,napi_invalid_arg);
  *out=ref->value; return status(e,napi_ok); API_END(e)
}
NAPI_EXTERN napi_status NAPI_CDECL napi_open_handle_scope(napi_env e, napi_handle_scope* out) {
  API_BEGIN(e) REQUIRE_RUNNING(e); if (!out) return status(e,napi_invalid_arg);
  if (e->scopes.size()>=kSlots) return failure(e);
  auto p=std::make_unique<napi_handle_scope__>(); *out=p.get(); e->scopes.push_back(std::move(p)); e->openScopes.push_back(*out); return status(e,napi_ok); API_END(e)
}
NAPI_EXTERN napi_status NAPI_CDECL napi_close_handle_scope(napi_env e, napi_handle_scope scope) {
  API_BEGIN(e) if (!owns(e->scopes,scope) || !scope->alive || e->openScopes.empty() || e->openScopes.back()!=scope) return status(e,napi_handle_scope_mismatch);
  e->openScopes.pop_back(); scope->alive=false; return status(e,napi_ok); API_END(e)
}
NAPI_EXTERN napi_status NAPI_CDECL napi_create_error(napi_env e, napi_value code, napi_value message, napi_value* out) {
  API_BEGIN(e) REQUIRE_RUNNING(e); if (!out) return status(e,napi_invalid_arg);
  if (!string(e,message) || (code && !string(e,code))) return status(e,napi_string_expected);
  *out=value(e,napi_object); if (!*out) return failure(e);
  auto s=property(e,*out,"message",message); if (s!=napi_ok) return s;
  return code?property(e,*out,"code",code):status(e,napi_ok); API_END(e)
}
NAPI_EXTERN napi_status NAPI_CDECL napi_create_type_error(napi_env e, napi_value code, napi_value message, napi_value* out) {
  return napi_create_error(e,code,message,out);
}
NAPI_EXTERN napi_status NAPI_CDECL napi_throw(napi_env e, napi_value error) {
  API_BEGIN(e) REQUIRE_RUNNING(e); if (!valid(e,error)) return status(e,napi_invalid_arg);
  e->pending=error; return status(e,napi_ok); API_END(e)
}
NAPI_EXTERN napi_status NAPI_CDECL napi_is_exception_pending(napi_env e, bool* out) {
  API_BEGIN(e) if (!out) return status(e,napi_invalid_arg); *out=e->pending!=nullptr; return status(e,napi_ok); API_END(e)
}
NAPI_EXTERN napi_status NAPI_CDECL napi_get_and_clear_last_exception(napi_env e, napi_value* out) {
  API_BEGIN(e) if (!out) return status(e,napi_invalid_arg); *out=e->pending?e->pending:e->undefined; e->pending=nullptr; return status(e,napi_ok); API_END(e)
}
NAPI_EXTERN napi_status NAPI_CDECL napi_add_finalizer(napi_env e, napi_value obj, void* data, node_api_basic_finalize cb, void* hint, napi_ref* out) {
  API_BEGIN(e) REQUIRE_RUNNING(e); if (!object(e,obj) || !cb) return status(e,napi_invalid_arg);
  if (e->finalizing || e->finalizers.size()>=kSlots) return failure(e);
  if (out) { auto s=napi_create_reference(e,obj,0,out); if (s!=napi_ok) return s; }
  e->finalizers.push_back({cb,data,hint}); return status(e,napi_ok); API_END(e)
}
NAPI_EXTERN NAPI_NO_RETURN void NAPI_CDECL napi_fatal_error(const char*, size_t, const char*, size_t) { std::_Exit(70); }
}

namespace {
struct Rejected {};
static void require(bool b) { if (!b) throw Rejected{}; }
static std::string lower(std::string s) { for (char& c:s) if (c>='A' && c<='Z') c+=32; return s; }
static bool token(const std::string& s) {
  if (s.empty()) return false;
  for (unsigned char c:s) if (!((c>='0'&&c<='9')||(c>='A'&&c<='Z')||(c>='a'&&c<='z')||strchr("!#$%&'*+-.^_`|~",c))) return false;
  return s.find('\0')==std::string::npos;
}
static bool plain(const std::string& s) {
  if (!utf8(s)) return false;
  for (unsigned char c:s) if ((c<32 && c!='\t') || c==127) return false;
  return true;
}
static std::vector<std::string> pairs(const std::string& text, bool output) {
  require(!text.empty() && text.size()<=kOutput && utf8(text));
  std::vector<std::string> p; size_t start=0;
  for (;;) {
    size_t end=text.find("\r\n",start);
    p.push_back(text.substr(start,end==std::string::npos?end:end-start));
    require(p.size()<=129);
    if (end==std::string::npos) break;
    start=end+2;
  }
  if (output && p.back().empty()) p.pop_back();
  require(!p.empty() && p.size()%2==0 && p.size()<=128);
  std::map<std::string,bool> names;
  for (size_t i=0;i<p.size();i+=2) {
    require(token(p[i]) && plain(p[i+1]) && (!output || !p[i+1].empty()));
    auto name=lower(p[i]); require(!names.count(name)); names[name]=true;
  }
  if (output) require(names.count("x-helios") && names.count("x-medusa"));
  return p;
}
static int hex(char c) {
  if(c>='0'&&c<='9') return c-'0'; if(c>='a'&&c<='f') return c-'a'+10; if(c>='A'&&c<='F') return c-'A'+10; return -1;
}
static std::string decoded(const std::string& s) {
  std::string out;
  for(size_t i=0;i<s.size();++i) {
    char c=s[i];
    if(c=='%') { require(i+2<s.size() && hex(s[i+1])>=0 && hex(s[i+2])>=0); c=static_cast<char>((hex(s[i+1])<<4)|hex(s[i+2])); i+=2; }
    else if(c=='+') c=' ';
    require(static_cast<unsigned char>(c)>=32 && c!=127); out.push_back(c);
  }
  require(utf8(out)); return out;
}
struct Request { std::string did, url, headers; };
static void validate(const Request& r) {
  require(r.did.size()==16);
  for(char c:r.did) require(c>='0'&&c<='9');
  require(r.url.size()<=32768);
  for(unsigned char c:r.url) require(c>32 && c<127 && c!='\\' && c!='#');
  const std::string prefix="https://api.qishui.com";
  require(r.url.compare(0,prefix.size(),prefix)==0);
  size_t start=prefix.size();
  if(r.url.compare(start,4,":443")==0) start+=4;
  require(start<r.url.size() && r.url[start]=='/');
  size_t q=r.url.find('?',start); require(q!=std::string::npos);
  std::string endpoint=r.url.substr(start,q-start);
  const char* allowed[]={"/luna/pc/feed/mode","/luna/pc/feed/song-tab","/luna/pc/discover","/luna/pc/discover/mix","/luna/pc/feed/radio/tracks","/luna/pc/me/recently-played-media","/luna/pc/track_v2"};
  bool found=false; for(const char* p:allowed) if(endpoint==p) found=true; require(found);
  size_t devices=0;
  for(size_t pos=q+1;pos<=r.url.size();) {
    size_t end=r.url.find('&',pos); if(end==std::string::npos) end=r.url.size();
    auto part=r.url.substr(pos,end-pos); auto eq=part.find('=');
    auto name=decoded(part.substr(0,eq)); auto val=eq==std::string::npos?std::string():decoded(part.substr(eq+1));
    if(name=="device_id") { require(val==r.did); ++devices; }
    if(end==r.url.size()) break; pos=end+1;
  }
  require(devices==1); pairs(r.headers,false);
}
static Request readRequest() {
  std::array<unsigned char,kInput+1> data{}; size_t used=0;
  while(used<data.size()) { size_t n=fread(data.data()+used,1,data.size()-used,stdin); used+=n; if(!n) break; }
  require(!ferror(stdin) && used<=kInput);
  size_t pos=0;
  auto field=[&]() {
    require(used-pos>=4);
    uint32_t n=(uint32_t(data[pos])<<24)|(uint32_t(data[pos+1])<<16)|(uint32_t(data[pos+2])<<8)|data[pos+3]; pos+=4;
    require(n<=used-pos); std::string s(reinterpret_cast<char*>(data.data()+pos),n); pos+=n; return s;
  };
  Request r; r.did=field(); r.url=field(); r.headers=field(); require(pos==used); validate(r); return r;
}
static napi_value stringValue(napi_env e,const std::string& text) {
  napi_value out=nullptr; require(napi_create_string_utf8(e,text.data(),text.size(),&out)==napi_ok); return out;
}
static napi_value invoke(napi_env e,napi_value exports,const char* name,std::vector<napi_value> args) {
  auto it=exports->properties.find(name);
  require(it!=exports->properties.end() && valid(e,it->second) && it->second->type==napi_function && it->second->callback);
  auto fn=it->second; napi_callback_info__ info{std::move(args),exports,fn->data};
  e->active=&info;
  napi_value result=nullptr;
  try { result=fn->callback(e,&info); } catch(...) { e->active=nullptr; throw; }
  e->active=nullptr; require(!e->pending && !e->failed);
  require(!result || valid(e,result)); return result?result:e->undefined;
}
static bool finalize(napi_env e) noexcept {
  if(e->finalizing) return false; e->finalizing=true;
  bool ok=true;
  // Consume each callback before invoking it; cleanup runs on success AND error.
  for(auto& f:e->finalizers) {
    auto cb=f.callback; f.callback=nullptr;
    if(cb) try { cb(e,f.data,f.hint); } catch(...) { ok=false; }
  }
  return ok && !e->pending && !e->failed && e->openScopes.empty();
}
#ifdef _WIN32
static HMODULE loadAddon() {
  require(!GetModuleHandleW(L"libnode.dll"));
  std::array<wchar_t,32768> name{};
  DWORD n=GetModuleFileNameW(nullptr,name.data(),DWORD(name.size())); require(n && n<name.size());
  std::wstring file(name.data(),n); auto slash=file.find_last_of(L"\\/"); require(slash!=std::wstring::npos);
  auto directory=file.substr(0,slash+1);
  require(SetDefaultDllDirectories(LOAD_LIBRARY_SEARCH_SYSTEM32|LOAD_LIBRARY_SEARCH_USER_DIRS));
  // Absolute module path + DLL_LOAD_DIR prevents CWD/PATH DLL resolution.
  auto module=LoadLibraryExW((directory+L"bdms.node").c_str(),nullptr,LOAD_LIBRARY_SEARCH_DLL_LOAD_DIR|LOAD_LIBRARY_SEARCH_SYSTEM32);
  require(module && !GetModuleHandleW(L"libnode.dll")); return module;
}
static FARPROC symbol(HMODULE module,const char* name) { return GetProcAddress(module,name); }
#else
static void* loadAddon() {
  std::array<char,32768> name{}; uint32_t size=uint32_t(name.size());
  require(_NSGetExecutablePath(name.data(),&size)==0);
  std::array<char,32768> resolved{}; require(realpath(name.data(),resolved.data()));
  std::string file(resolved.data()); auto slash=file.find_last_of('/'); require(slash!=std::string::npos);
  void* module=dlopen((file.substr(0,slash+1)+"bdms.node").c_str(),RTLD_NOW|RTLD_LOCAL); require(module); return module;
}
static void* symbol(void* module,const char* name) { return dlsym(module,name); }
#endif
// SDK diagnostics are untrusted: suppress both standard streams while it runs.
// Keep private duplicates solely for the final response and fixed host errors.
struct Channels {
  int output=-1, error=-1;
  Channels() {
    output=FD_DUP(1); error=FD_DUP(2); require(output>=0 && error>=0);
#ifdef _WIN32
    int nullfd=_open("NUL",_O_WRONLY|_O_BINARY);
#else
    int nullfd=open("/dev/null",O_WRONLY);
#endif
    require(nullfd>=0); int a=FD_DUP2(nullfd,1), b=FD_DUP2(nullfd,2); FD_CLOSE(nullfd); require(a>=0 && b>=0);
#ifdef _WIN32
    // Native DLL code can use Win32 handles without touching the CRT fds.
    require(SetStdHandle(STD_OUTPUT_HANDLE,reinterpret_cast<HANDLE>(_get_osfhandle(1))) &&
            SetStdHandle(STD_ERROR_HANDLE,reinterpret_cast<HANDLE>(_get_osfhandle(2))));
#endif
  }
  ~Channels() { if(output>=0) FD_CLOSE(output); if(error>=0) FD_CLOSE(error); }
};
static bool writeAll(int fd,const std::string& text) {
  size_t used=0;
  while(used<text.size()) { auto n=FD_WRITE(fd,text.data()+used,static_cast<unsigned int>(text.size()-used)); if(n<=0) return false; used+=size_t(n); }
  return true;
}
}
#ifndef SIGNER_TEST
static int runSigner(int argc) {
#ifdef _WIN32
  if(_setmode(0,_O_BINARY)<0 || _setmode(1,_O_BINARY)<0 || _setmode(2,_O_BINARY)<0) return 74;
#else
  // A disconnected parent must result in a controlled write error.
  signal(SIGPIPE,SIG_IGN);
#endif
  if(argc!=1) { fputs("signer: invalid input\n",stderr); return 64; }
  Request request;
  try { request=readRequest(); } catch(...) { fputs("signer: invalid input\n",stderr); return 64; }
  try {
    Channels channels;
    std::unique_ptr<napi_env__> e;
    const char* diagnostic="signer: SDK load failed\n";
    try {
      auto module=loadAddon();
      diagnostic="signer: SDK module failed\n";
      auto version=reinterpret_cast<node_api_addon_get_api_version_func>(symbol(module,"node_api_module_get_api_version_v1"));
      auto registration=reinterpret_cast<napi_addon_register_func>(symbol(module,"napi_register_module_v1"));
      require(version && version()==8 && registration);
      e=std::make_unique<napi_env__>(); e->undefined=value(e.get(),napi_undefined);
      auto exports=value(e.get(),napi_object); require(exports && e->undefined);
      diagnostic="signer: SDK registration failed\n";
      auto registered=registration(e.get(),exports); require(object(e.get(),registered) && !e->pending && !e->failed);
      auto config=value(e.get(),napi_object); require(config);
      require(property(e.get(),config,"deviceId",stringValue(e.get(),request.did))==napi_ok);
      diagnostic="signer: SDK initialization failed\n";
      invoke(e.get(),registered,"init",{config});
      diagnostic="signer: SDK signing failed\n";
      auto result=invoke(e.get(),registered,"generateHttpSignatureHeaders",{stringValue(e.get(),request.url),stringValue(e.get(),request.headers)});
      diagnostic="signer: SDK output rejected\n";
      require(string(e.get(),result)); pairs(result->text,true);
      diagnostic="signer: SDK cleanup failed\n";
      require(finalize(e.get()));
      // Do not dlclose: native static destructors and callback code must remain
      // mapped until exit. Explicit SDK finalizers already ran exactly once.
      if(!writeAll(channels.output,result->text)) { writeAll(channels.error,"signer: output failed\n"); return 74; }
      return 0;
    } catch(...) {
      if(e && !e->finalizing) finalize(e.get());
      writeAll(channels.error,diagnostic); return 70;
    }
  } catch(...) { return 74; }
}
// The SDK is a one-shot guest. Skip CRT/DSO static destruction after explicit
// finalization, so no SDK destructor can revisit the released host arena.
int main(int argc,char**) { std::_Exit(runSigner(argc)); }
#endif

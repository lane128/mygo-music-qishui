// Tests exercise host boundaries without loading any SDK.
#define SIGNER_TEST
#include "signer.cpp"
#include <cassert>

static int finalized=0;
static void NAPI_CDECL countedFinalizer(node_api_basic_env,void*,void*) { ++finalized; }
static void NAPI_CDECL throwingFinalizer(node_api_basic_env,void*,void*) { ++finalized; throw Rejected{}; }
static Request base() {
  return {"1234567890123456","https://api.qishui.com/luna/pc/track_v2?device_id=1234567890123456", "accept\r\napplication/json"};
}
template<class F> static bool rejected(F f) { try { f(); return false; } catch(...) { return true; } }
int main() {
  auto p=std::make_unique<napi_env__>(); auto e=p.get(); e->undefined=value(e,napi_undefined);
  napi_value obj=nullptr, text=nullptr, out=nullptr;
  assert(napi_create_object(e,&obj)==napi_ok);
  assert(napi_create_string_utf8(e,"a\xe6\xb5\x8b\xf0\x9f\x8e\xb5",8,&text)==napi_ok);
  size_t n=0; char buf[16]{};
  assert(napi_get_value_string_utf8(e,text,nullptr,0,&n)==napi_ok && n==8);
  assert(napi_get_value_string_utf8(e,text,buf,4,&n)==napi_ok && n==1 && buf[1]==0);
  assert(napi_get_value_string_utf8(e,text,buf,6,&n)==napi_ok && n==4 && buf[4]==0);
  assert(napi_get_value_string_utf8(e,text,buf,9,&n)==napi_ok && n==8 && buf[8]==0);
  assert(napi_get_value_string_utf8(e,text,buf,0,&n)==napi_ok && n==0);
  assert(napi_get_value_string_utf8(e,text,nullptr,0,nullptr)==napi_invalid_arg);
  assert(napi_create_string_utf8(e,"\xc0\x80",2,&out)==napi_invalid_arg);
  assert(napi_create_string_utf8(e,"\xed\xa0\x80",3,&out)==napi_invalid_arg);
  assert(napi_typeof(e,reinterpret_cast<napi_value>(uintptr_t(1)),nullptr)==napi_invalid_arg);
  napi_ref ref=nullptr;
  assert(napi_create_reference(e,obj,0,&ref)==napi_ok);
  assert(napi_get_reference_value(e,ref,&out)==napi_ok && out==obj);
  assert(napi_delete_reference(e,ref)==napi_ok);
  assert(napi_delete_reference(e,ref)==napi_invalid_arg);
  assert(napi_get_reference_value(e,ref,&out)==napi_invalid_arg);
  assert(napi_delete_reference(e,reinterpret_cast<napi_ref>(uintptr_t(1)))==napi_invalid_arg);
  napi_handle_scope first=nullptr, second=nullptr;
  assert(napi_open_handle_scope(e,&first)==napi_ok && napi_open_handle_scope(e,&second)==napi_ok);
  assert(napi_close_handle_scope(e,first)==napi_handle_scope_mismatch);
  assert(napi_close_handle_scope(e,second)==napi_ok && napi_close_handle_scope(e,first)==napi_ok);
  assert(napi_close_handle_scope(e,first)==napi_handle_scope_mismatch);
  napi_callback_info__ info{{text},obj,reinterpret_cast<void*>(uintptr_t(7))}; e->active=&info;
  napi_value args[3]{}; n=3; void* data=nullptr;
  assert(napi_get_cb_info(e,&info,&n,args,&out,&data)==napi_ok && n==1 && args[0]==text && args[1]==e->undefined && args[2]==e->undefined && out==obj && data==info.data);
  e->active=nullptr; assert(napi_get_cb_info(e,&info,&n,args,nullptr,nullptr)==napi_invalid_arg);
  assert(napi_throw(e,text)==napi_ok);
  assert(napi_create_object(e,&out)==napi_pending_exception);
  bool pending=false; assert(napi_is_exception_pending(e,&pending)==napi_ok && pending);
  assert(napi_get_and_clear_last_exception(e,&out)==napi_ok && out==text);
  assert(napi_is_exception_pending(e,&pending)==napi_ok && !pending);
  assert(napi_create_error(e,obj,text,&out)==napi_string_expected);
  assert(napi_add_finalizer(e,obj,nullptr,countedFinalizer,nullptr,nullptr)==napi_ok);
  assert(napi_add_finalizer(e,obj,nullptr,throwingFinalizer,nullptr,nullptr)==napi_ok);
  assert(napi_add_finalizer(e,obj,nullptr,countedFinalizer,nullptr,nullptr)==napi_ok);
  assert(!finalize(e) && finalized==3); assert(!finalize(e) && finalized==3);
  assert(napi_add_finalizer(e,obj,nullptr,countedFinalizer,nullptr,nullptr)==napi_generic_failure);

  auto r=base(); validate(r);
  for(const auto& did:{"123456789012345","12345678901234567","123456789012345x"}) { r=base(); r.did=did; assert(rejected([&]{validate(r);})); }
  for(const auto& suffix:{"&device_id=1234567890123456","&%64evice_id=1234567890123456","&foo=%00","&foo=%zz","#fragment"}) { r=base(); r.url+=suffix; assert(rejected([&]{validate(r);})); }
  for(const auto& headers:{"bad name\r\nx","x\r\nv\nx","x\r\nv\rx","x\r\nv\r\n","x\r\nv\r\nX\r\nv","x",""}) { r=base(); r.headers=headers; assert(rejected([&]{validate(r);})); }
  r=base(); r.headers="x\r\n\xe6\xb5\x8b\xe8\xaf\x95"; validate(r);
  pairs("x-helios\r\na\r\nx-medusa\r\nb\r\n",true);
  for(const auto& output:{"x-helios\r\na","x-helios\r\na\r\nx-medusa\r\n","x-helios\r\na\r\nx-medusa\r\nb\r\n\r\n","x-helios\r\na\r\nX-Helios\r\nb\r\nx-medusa\r\nc"}) assert(rejected([&]{pairs(output,true);}));

  auto limited=std::make_unique<napi_env__>(); limited->undefined=value(limited.get(),napi_undefined);
  std::string large(kString,'x');
  for(size_t i=0;i<8;++i) assert(napi_create_string_utf8(limited.get(),large.data(),large.size(),&out)==napi_ok);
  assert(napi_create_string_utf8(limited.get(),"x",1,&out)==napi_generic_failure && limited->failed);
  auto full=std::make_unique<napi_env__>(); full->undefined=value(full.get(),napi_undefined);
  for(size_t i=1;i<kSlots;++i) assert(napi_create_object(full.get(),&out)==napi_ok);
  assert(napi_create_object(full.get(),&out)==napi_generic_failure && full->failed);
  puts("native signer boundary tests passed");
}

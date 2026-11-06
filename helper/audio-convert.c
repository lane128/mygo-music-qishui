// Build: clang -O2 -framework AudioToolbox -framework CoreFoundation audio-convert.c -o audio-convert
// Decodes the already-authorized AAC resource to native FLAC for MyGO. No network.
#include <AudioToolbox/AudioToolbox.h>
#include <CoreFoundation/CoreFoundation.h>
#include <sys/resource.h>
#include <stdint.h>
#include <stdlib.h>
#include <string.h>

#define MAX_BYTES (128u * 1024u * 1024u)

int main(int argc, char **argv) {
    if (argc != 3) return 1;
    struct rlimit files = { MAX_BYTES, MAX_BYTES };
    if (setrlimit(RLIMIT_FSIZE, &files)) return 1;
    CFURLRef inputURL = CFURLCreateFromFileSystemRepresentation(NULL, (const UInt8 *)argv[1], strlen(argv[1]), false);
    CFURLRef outputURL = CFURLCreateFromFileSystemRepresentation(NULL, (const UInt8 *)argv[2], strlen(argv[2]), false);
    ExtAudioFileRef input = NULL, output = NULL;
    void *samples = NULL;
    int result = 1;
    if (!inputURL || !outputURL || ExtAudioFileOpenURL(inputURL, &input)) goto done;
    AudioStreamBasicDescription source = {0};
    UInt32 size = sizeof(source);
    if (ExtAudioFileGetProperty(input, kExtAudioFileProperty_FileDataFormat, &size, &source)) goto done;
    // Only AAC is converted here. Other formats never enter this decoder path.
    if (!(source.mFormatID == kAudioFormatMPEG4AAC || source.mFormatID == kAudioFormatMPEG4AAC_HE ||
          source.mFormatID == kAudioFormatMPEG4AAC_HE_V2) || source.mChannelsPerFrame < 1 ||
        source.mChannelsPerFrame > 8 || source.mSampleRate < 8000 || source.mSampleRate > 384000) goto done;
    AudioStreamBasicDescription target = {0};
    target.mFormatID = kAudioFormatFLAC;
    target.mSampleRate = source.mSampleRate;
    target.mChannelsPerFrame = source.mChannelsPerFrame;
    target.mBitsPerChannel = 24;
    if (ExtAudioFileCreateWithURL(outputURL, kAudioFileFLACType, &target, NULL, kAudioFileFlags_EraseFile, &output)) goto done;
    AudioStreamBasicDescription pcm = {0};
    pcm.mFormatID = kAudioFormatLinearPCM;
    pcm.mFormatFlags = kAudioFormatFlagIsSignedInteger | kAudioFormatFlagIsPacked | kAudioFormatFlagsNativeEndian;
    pcm.mSampleRate = source.mSampleRate;
    pcm.mChannelsPerFrame = source.mChannelsPerFrame;
    pcm.mBitsPerChannel = 32;
    pcm.mFramesPerPacket = 1;
    pcm.mBytesPerFrame = pcm.mBytesPerPacket = source.mChannelsPerFrame * 4;
    if (ExtAudioFileSetProperty(input, kExtAudioFileProperty_ClientDataFormat, sizeof(pcm), &pcm) ||
        ExtAudioFileSetProperty(output, kExtAudioFileProperty_ClientDataFormat, sizeof(pcm), &pcm)) goto done;
    samples = malloc(4096 * pcm.mBytesPerFrame);
    if (!samples) goto done;
    uint64_t total = 0;
    for (;;) {
        UInt32 frames = 4096;
        AudioBufferList list = {0};
        list.mNumberBuffers = 1;
        list.mBuffers[0].mNumberChannels = pcm.mChannelsPerFrame;
        list.mBuffers[0].mDataByteSize = frames * pcm.mBytesPerFrame;
        list.mBuffers[0].mData = samples;
        if (ExtAudioFileRead(input, &frames, &list)) goto done;
        if (!frames) break;
        total += frames;
        // Cap decoded work as well as the compressed file. Never pad to track metadata.
        if (total > MAX_BYTES / (pcm.mChannelsPerFrame * 3) || ExtAudioFileWrite(output, frames, &list)) goto done;
    }
    if (!total) goto done;
    result = 0;
done:
    free(samples);
    if (input && ExtAudioFileDispose(input)) result = 1;
    if (output && ExtAudioFileDispose(output)) result = 1;
    if (inputURL) CFRelease(inputURL);
    if (outputURL) CFRelease(outputURL);
    return result;
}

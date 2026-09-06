// libFuzzer target for the Touch ID addon, built by scripts/fuzz-native.mjs
// under AddressSanitizer and UndefinedBehaviorSanitizer.
//
// This addon parses no lengths: it is handed an account name, a prompt and a
// buffer, passes them to the Security framework, and copies back whatever
// NSData the OS returns. So the target is smaller than the PC/SC one, and it
// covers the two things that are decisions rather than pass-through:
//
//   Scrub        every byte of key material is overwritten before the
//                allocation goes back to the heap. Under ASan a wipe that
//                walks off the end of the vector is a report rather than a
//                silent corruption of whatever follows it.
//   ToNSString   which byte strings can name a keychain item. Two names that
//                both fail to convert must not become the same name, or one
//                database's key is read under another's.
//
// ToNSString needs Foundation, so that half compiles on macOS only and the
// security workflow runs this target on a macOS runner as well as Linux. The
// keychain itself is never touched: no SecItem call, no entitlement, no
// prompt, nothing that needs a device.

#include <cassert>
#include <cstdint>
#include <cstring>
#include <string>
#include <vector>

#ifdef __APPLE__
#import <Foundation/Foundation.h>
#endif

#include "../src/touchid_parse.h"

namespace {

// A wipe has to reach every byte and leave nothing behind it. The bytes are
// read back through the same allocation before the vector is destroyed,
// which is what makes an under- or over-run visible
void CheckScrub(const uint8_t* data, size_t size) {
    std::vector<uint8_t> secret(data, data + size);
    const size_t capacity = secret.capacity();
    uint8_t* storage = secret.data();

    vigil_touchid::Scrub(secret);

    assert(secret.empty() && "a scrubbed buffer kept its contents");
    // clear() does not free, so the allocation is still ours to inspect
    assert(secret.capacity() == capacity && "the wipe reallocated instead of overwriting");
    for (size_t i = 0; i < size; ++i) {
        assert(storage[i] == 0 && "a byte of key material survived the wipe");
    }
}

#ifdef __APPLE__

// The name a keychain query is built with, for arbitrary bytes. Either the
// bytes are a string, and it is exactly those bytes back, or there is no
// string and the caller refuses the operation
void CheckToNSString(const uint8_t* data, size_t size) {
    @autoreleasepool {
        const std::string value(reinterpret_cast<const char*>(data), size);
        NSString* name = vigil_touchid::ToNSString(value);
        if (name == nil) return;

        // A name that came back must be the bytes it was made from: anything
        // else and two different accounts could share one keychain item
        const char* utf8 = [name UTF8String];
        assert(utf8 != nullptr && "a string that cannot be read back");
        assert(std::strlen(utf8) == value.size() && "a name changed length on the way through");
        assert(std::memcmp(utf8, value.data(), value.size()) == 0 && "a name is not the bytes it was made from");
        // The empty name is what the old fallback produced for anything that
        // would not convert; it may only come from an empty input now
        assert((value.empty() || [name length] > 0) && "a non-empty name converted to nothing");
    }
}

#endif  // __APPLE__

}  // namespace

extern "C" int LLVMFuzzerTestOneInput(const uint8_t* data, size_t size) {
    CheckScrub(data, size);
#ifdef __APPLE__
    CheckToNSString(data, size);
#endif
    return 0;
}

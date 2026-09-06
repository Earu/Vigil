// libFuzzer target for the Touch ID addon, built by scripts/fuzz-native.mjs
// under AddressSanitizer and UndefinedBehaviorSanitizer.
//
// This addon parses no lengths: it is handed an account name, a prompt and a
// buffer, passes them to the Security framework, and copies back whatever
// NSData the OS returns. So the target is smaller than the PC/SC one, and it
// covers the two things that are decisions rather than pass-through:
//
//   Scrub           every byte of key material is overwritten before the
//                   allocation goes back to the heap. Under ASan a wipe that
//                   walks off the end of the vector is a report rather than a
//                   silent corruption of whatever follows it.
//   IsKeychainName  which byte strings can name a keychain item. It walks
//   ToNSString      multi-byte sequences by hand, so under ASan a step past
//                   the end of a truncated one is a report. On macOS the
//                   NSString the addon builds from an accepted name is then
//                   checked against the bytes it came from: two names that
//                   differ must not become the same name, or one database's
//                   key is read under another's.
//
// ToNSString needs Foundation, so that check compiles on macOS only and the
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

// What the validator promises about a name it accepts, stated without
// Foundation so it holds on every platform the target is built on
bool CheckKeychainName(const std::string& value) {
    const bool accepted = vigil_touchid::IsKeychainName(value);
    if (accepted) {
        assert(value.find('\0') == std::string::npos && "a name with a NUL in it was accepted");
        assert(value.compare(0, 3, "\xEF\xBB\xBF") != 0 && "a name with a leading byte order mark was accepted");
    }
    assert(vigil_touchid::IsKeychainName(value) == accepted && "the decision changed on a second look");
    return accepted;
}

#ifdef __APPLE__

// The name a keychain query is built with, for arbitrary bytes. Either the
// validator refuses them and there is no string, or there is one and it is
// exactly those bytes back. The second half is what keeps the validator
// honest: NSString has its own ideas about malformed input (a stray 0xA9
// becomes U+FFFD, a leading byte order mark is dropped), and any of them the
// validator lets through shows up here as a name that is not its bytes
void CheckToNSString(const std::string& value, bool accepted) {
    @autoreleasepool {
        NSString* name = vigil_touchid::ToNSString(value);
        if (!accepted) {
            assert(name == nil && "a refused name still became a string");
            return;
        }
        // Well-formed UTF-8 is something NSString always takes, so the
        // validator's yes must be Foundation's yes as well
        assert(name != nil && "an accepted name did not become a string");

        // A name that came back must be the bytes it was made from: anything
        // else and two different accounts could share one keychain item. The
        // length is asked of the string, not measured with strlen: the first
        // run of this target on macOS did that, and the assertion tripped on
        // an embedded NUL rather than on a real change of length
        NSData* bytes = [name dataUsingEncoding:NSUTF8StringEncoding];
        assert(bytes != nil && "a string that cannot be read back");
        assert([bytes length] == value.size() && "a name changed length on the way through");
        assert(std::memcmp([bytes bytes], value.data(), value.size()) == 0 && "a name is not the bytes it was made from");
        // The empty name is what the old fallback produced for anything that
        // would not convert; it may only come from an empty input now
        assert((value.empty() || [name length] > 0) && "a non-empty name converted to nothing");
    }
}

#endif  // __APPLE__

}  // namespace

extern "C" int LLVMFuzzerTestOneInput(const uint8_t* data, size_t size) {
    CheckScrub(data, size);
    const std::string value(reinterpret_cast<const char*>(data), size);
    const bool accepted = CheckKeychainName(value);
#ifdef __APPLE__
    CheckToNSString(value, accepted);
#else
    (void) accepted;
#endif
    return 0;
}

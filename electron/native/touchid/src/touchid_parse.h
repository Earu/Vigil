// The parts of the Touch ID addon that take a value and decide something
// about it, separated from the keychain calls so they can be reached without
// macOS, entitlements, an enrolled finger or a prompt on screen.
//
// There is less here than in the PC/SC addon's equivalent, and the reason is
// worth stating: nothing in this addon parses a length. It is handed an
// account name, a prompt and a buffer, passes them to the Security framework,
// and copies back whatever NSData the OS returns. What is left is the wipe
// that key material goes through and the decision about what can name a
// keychain item, and both of those are fuzzed by fuzz/touchid_fuzz.cc.
//
// The Objective-C half is behind __OBJC__ so the same header serves
// touchid_mac.mm and a fuzz target compiled as plain C++ on other platforms.

#ifndef VIGIL_TOUCHID_PARSE_H_
#define VIGIL_TOUCHID_PARSE_H_

#include <cstddef>
#include <cstdint>
#include <string>
#include <vector>

namespace vigil_touchid {

// Overwrite key material before the vector's storage goes back to the heap.
// Written through a volatile pointer so the compiler cannot drop the stores
// as dead writes, which is exactly what it may do to a plain memset here
inline void Scrub(std::vector<uint8_t>& buffer) {
    volatile uint8_t* p = buffer.data();
    for (size_t i = 0; i < buffer.size(); ++i) {
        p[i] = 0;
    }
    buffer.clear();
}

#ifdef __OBJC__

// nil when the bytes are not something NSString can hold, rather than the
// empty string. Two account names that both failed to convert would otherwise
// name the same keychain item, and the caller would read one database's key
// under another's name. Every caller checks for nil and refuses the operation
inline NSString* ToNSString(const std::string& value) {
    return [[NSString alloc] initWithBytes:value.data()
                                    length:value.size()
                                  encoding:NSUTF8StringEncoding];
}

#endif  // __OBJC__

}  // namespace vigil_touchid

#endif  // VIGIL_TOUCHID_PARSE_H_

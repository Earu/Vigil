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

// nil when the bytes cannot name a keychain item, rather than the empty
// string. Two account names that both failed to convert would otherwise name
// the same item, and the caller would read one database's key under
// another's name. Every caller checks for nil and refuses the operation.
//
// A NUL is refused as well, although NSString would take it. In the Security
// framework's source the legacy keychain converts string attributes with
// CFStringGetCString and measures them with strlen (libsecurity_keychain
// SecItem.cpp, CloneDataByType), so there a name ends at its first NUL and
// two names can be one item. This addon asks for the data protection
// keychain, which SecItemCategorizeQuery routes away from that code
// entirely: the query crosses XPC as a length-prefixed DER string
// (der_encode_string) and securityd keeps it as a CFString and binds it as
// CFData (SecDbItem.c copyString, copyData), so on that path a NUL is kept.
// The refusal costs nothing, since no account name is a path with a NUL in
// it, and it keeps the guarantee from resting on the keychain flag alone
inline NSString* ToNSString(const std::string& value) {
    if (value.find('\0') != std::string::npos) return nil;
    return [[NSString alloc] initWithBytes:value.data()
                                    length:value.size()
                                  encoding:NSUTF8StringEncoding];
}

#endif  // __OBJC__

}  // namespace vigil_touchid

#endif  // VIGIL_TOUCHID_PARSE_H_

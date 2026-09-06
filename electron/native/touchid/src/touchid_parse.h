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

// Whether the bytes are well-formed UTF-8: the sequences of Unicode 16
// Table 3-7, so no overlong form, no surrogate, nothing past U+10FFFF and
// no continuation byte on its own. Plain C++ so the fuzz target reaches it
// on every platform; under AddressSanitizer a step past the end of a
// truncated sequence is a report
inline bool IsWellFormedUtf8(const std::string& value) {
    const auto* bytes = reinterpret_cast<const unsigned char*>(value.data());
    const size_t size = value.size();
    size_t i = 0;
    while (i < size) {
        const unsigned char lead = bytes[i];
        if (lead < 0x80) {
            ++i;
            continue;
        }
        size_t length;
        unsigned char low = 0x80;
        unsigned char high = 0xBF;
        if (lead >= 0xC2 && lead <= 0xDF) {
            length = 2;
        } else if (lead == 0xE0) {
            length = 3;
            low = 0xA0;
        } else if (lead >= 0xE1 && lead <= 0xEC) {
            length = 3;
        } else if (lead == 0xED) {
            length = 3;
            high = 0x9F;
        } else if (lead == 0xEE || lead == 0xEF) {
            length = 3;
        } else if (lead == 0xF0) {
            length = 4;
            low = 0x90;
        } else if (lead >= 0xF1 && lead <= 0xF3) {
            length = 4;
        } else if (lead == 0xF4) {
            length = 4;
            high = 0x8F;
        } else {
            return false;
        }
        if (size - i < length) return false;
        if (bytes[i + 1] < low || bytes[i + 1] > high) return false;
        for (size_t k = 2; k < length; ++k) {
            if (bytes[i + k] < 0x80 || bytes[i + k] > 0xBF) return false;
        }
        i += length;
    }
    return true;
}

// Whether the bytes can name a keychain item, which is decided here rather
// than left to NSString. The rule is that a name is exactly its bytes: two
// different byte strings must never become one NSString, or the caller reads
// one database's key under another's name. NSString does not keep to that
// on its own. The first macOS fuzz run found that it accepts an embedded NUL,
// the next that it takes a stray continuation byte (0xA9 after a complete
// character, though not 0x80 or 0xBF) and replaces it with U+FFFD, and that
// it strips one leading byte order mark, so "\xEF\xBB\xBF" "vault" and
// "vault" were one item. What it does with malformed input varies by byte
// and by OS release, so nothing malformed reaches it, and neither does a
// leading BOM.
//
// The NUL is refused although NSString would keep it. In the Security
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
inline bool IsKeychainName(const std::string& value) {
    if (value.find('\0') != std::string::npos) return false;
    if (value.compare(0, 3, "\xEF\xBB\xBF") == 0) return false;
    return IsWellFormedUtf8(value);
}

#ifdef __OBJC__

// nil when the bytes cannot name a keychain item, rather than the empty
// string. Two account names that both failed to convert would otherwise name
// the same item, and the caller would read one database's key under
// another's name. Every caller checks for nil and refuses the operation
inline NSString* ToNSString(const std::string& value) {
    if (!IsKeychainName(value)) return nil;
    return [[NSString alloc] initWithBytes:value.data()
                                    length:value.size()
                                  encoding:NSUTF8StringEncoding];
}

#endif  // __OBJC__

}  // namespace vigil_touchid

#endif  // VIGIL_TOUCHID_PARSE_H_

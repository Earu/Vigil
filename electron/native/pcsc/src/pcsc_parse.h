// The decisions this addon makes about the bytes and lengths PC/SC hands
// back, separated from the N-API surface so they can be reached without an
// Electron process, a card, or a reader.
//
// Everything a driver reports is input: the reader names come out of
// SCardListReaders as a multi-string whose length the driver states, and the
// response length comes out of SCardTransmit as an out parameter. A driver
// that states more than it wrote, or a device that answers with something no
// reader would, must not turn into a read past a buffer. fuzz/pcsc_fuzz.cc
// compiles this header on its own, under AddressSanitizer, and drives it with
// arbitrary bytes.
//
// Header-only and free of napi.h and winscard.h on purpose: the fuzz build
// needs neither, and neither is available on a machine with no PC/SC at all.

#ifndef VIGIL_PCSC_PARSE_H_
#define VIGIL_PCSC_PARSE_H_

#include <cstddef>
#include <cstdint>
#include <string>
#include <vector>

namespace vigil_pcsc {

// Largest response an extended-length APDU can carry, plus the status word
constexpr size_t kMaxResponse = 65538;

// An extended APDU is a 4 byte header, a 3 byte length, the body and 2 bytes
// of expected length. Nothing the OATH driver sends is near this; the bound
// is here so a buffer from JS cannot reach the DWORD cast wider than a DWORD
constexpr size_t kMaxApdu = 65544;

// A multi-string: NUL-separated names ending with a second NUL. `length` is
// what the driver said it wrote, which is not necessarily what it wrote, so
// the buffer's own size is the one that bounds the read
inline std::vector<std::string> SplitMultiString(const std::vector<char>& buffer, size_t length) {
    std::vector<std::string> names;
    size_t start = 0;
    const size_t end = length <= buffer.size() ? length : buffer.size();
    for (size_t i = 0; i < end; ++i) {
        if (buffer[i] != '\0') continue;
        // An empty name is the second NUL: the end of the list
        if (i == start) break;
        names.emplace_back(buffer.data() + start, i - start);
        start = i + 1;
    }
    return names;
}

// How far the response buffer may be trusted after a transmit. A failed call
// wrote nothing, and a driver reporting more than the buffer it was given
// would otherwise resize past the bytes it actually filled
inline size_t TransmitResponseLength(bool ok, size_t reported, size_t capacity) {
    if (!ok) return 0;
    return reported <= capacity ? reported : capacity;
}

// Overwrite before the storage goes back to the heap: a PUT's APDU carries an
// OTP secret. Written through a volatile pointer so the compiler cannot drop
// the stores as dead writes
inline void Scrub(std::vector<uint8_t>& buffer) {
    volatile uint8_t* p = buffer.data();
    for (size_t i = 0; i < buffer.size(); ++i) {
        p[i] = 0;
    }
    buffer.clear();
}

}  // namespace vigil_pcsc

#endif  // VIGIL_PCSC_PARSE_H_

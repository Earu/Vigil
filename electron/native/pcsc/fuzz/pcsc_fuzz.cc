// libFuzzer target for the addon's own parsing, built by
// scripts/fuzz-native.mjs under AddressSanitizer and UndefinedBehaviorSanitizer.
//
// Everything this addon reads comes from outside the process: a reader name is
// whatever the driver put in the multi-string, and the response length is
// whatever SCardTransmit reported. It is C++, so a length that disagrees with
// its buffer is a read past the end rather than an exception.
// A crash here is a finding; so is any invariant below, since the JS side
// treats what comes back as a list of names and a slice of a response.
//
// The corpus in corpus/ is the shape a real listing has, so the fuzzer starts
// from something that parses rather than from random bytes.

#include <cassert>
#include <cstdint>
#include <cstring>
#include <string>
#include <vector>

#include "../src/pcsc_parse.h"

namespace {

// Names come out of the multi-string as byte ranges of the buffer, so every
// one of them has to be exactly the bytes at the offset it was cut from, with
// no NUL inside it and nothing invented past the length the driver claimed
void CheckSplit(const std::vector<char>& buffer, size_t claimed) {
    const std::vector<std::string> names = vigil_pcsc::SplitMultiString(buffer, claimed);
    const size_t end = claimed <= buffer.size() ? claimed : buffer.size();

    size_t offset = 0;
    for (const std::string& name : names) {
        assert(!name.empty() && "a name in the list is the terminator");
        assert(name.find('\0') == std::string::npos && "a name carries a separator");
        assert(offset + name.size() < end && "a name reaches past what the driver wrote");
        assert(std::memcmp(buffer.data() + offset, name.data(), name.size()) == 0
               && "a name is not the bytes it was cut from");
        assert(buffer[offset + name.size()] == '\0' && "a name did not end at a separator");
        offset += name.size() + 1;
    }
    assert(offset <= end && "the walk ran past the buffer");
}

// The length the JS side is handed a response of. Whatever the driver
// reported, the slice has to stay inside the buffer that was actually filled
void CheckTransmitLength(bool ok, size_t reported) {
    const size_t length = vigil_pcsc::TransmitResponseLength(ok, reported, vigil_pcsc::kMaxResponse);
    assert(length <= vigil_pcsc::kMaxResponse && "a response past the buffer it was read into");
    assert(length <= reported && "a response longer than the driver reported");
    assert((ok || length == 0) && "a failed transmit yielded bytes");
}

}  // namespace

extern "C" int LLVMFuzzerTestOneInput(const uint8_t* data, size_t size) {
    // The first four bytes are the length the driver claims, which is the
    // interesting part: it is under no obligation to match what follows
    uint32_t claimed = 0;
    if (size >= 4) {
        std::memcpy(&claimed, data, 4);
        data += 4;
        size -= 4;
    }

    const std::vector<char> buffer(reinterpret_cast<const char*>(data), reinterpret_cast<const char*>(data) + size);

    // Both the driver's word and the truth, so a claim shorter than the
    // buffer is covered as well as one past the end of it
    CheckSplit(buffer, claimed);
    CheckSplit(buffer, buffer.size());

    CheckTransmitLength(true, claimed);
    CheckTransmitLength(false, claimed);

    std::vector<uint8_t> secret(data, data + size);
    vigil_pcsc::Scrub(secret);
    assert(secret.empty() && "a scrubbed buffer kept its length");

    return 0;
}

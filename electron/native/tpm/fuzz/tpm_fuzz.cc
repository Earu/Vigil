#include <cassert>
#include <cstdint>
#include <cstring>
#include <string>
#include <vector>

#include "../src/tpm_parse.h"

namespace {

constexpr size_t kRealMaxPrivate = 1550;
constexpr size_t kRealMaxPublic = 616;

__attribute__((no_sanitize("address"))) uint8_t ReadRetained(const void* storage, size_t index) {
    return static_cast<const volatile uint8_t*>(storage)[index];
}

void CheckScrubBytes(const uint8_t* data, size_t size) {
    std::vector<uint8_t> secret(data, data + size);
    const size_t capacity = secret.capacity();
    uint8_t* storage = secret.data();
    vigil_tpm::Scrub(secret);
    assert(secret.empty() && "a scrubbed buffer kept its contents");
    assert(secret.capacity() == capacity && "the wipe reallocated instead of overwriting");
    for (size_t i = 0; i < size; ++i) assert(ReadRetained(storage, i) == 0 && "a byte of key material survived the wipe");
}

void CheckScrubText(const uint8_t* data, size_t size) {
    std::string pin(reinterpret_cast<const char*>(data), size);
    pin.reserve(pin.size() + 32);
    const size_t length = pin.size();
    const size_t capacity = pin.capacity();
    char* storage = pin.empty() ? nullptr : &pin[0];
    vigil_tpm::Scrub(pin);
    assert(pin.empty() && "a scrubbed PIN kept its contents");
    assert(pin.capacity() == capacity && "the wipe reallocated instead of overwriting");
    for (size_t i = 0; i < length; ++i) assert(ReadRetained(storage, i) == 0 && "a byte of the PIN survived the wipe");
}

void CheckPin(const uint8_t* data, size_t size) {
    const std::string pin(reinterpret_cast<const char*>(data), size);
    bool expected = size >= 1 && size <= vigil_tpm::kMaxPinLength;
    for (size_t i = 0; expected && i < size; ++i) expected = data[i] >= '0' && data[i] <= '9';
    assert(vigil_tpm::IsPin(pin) == expected && "the PIN rule disagrees with its definition");
}

void CheckSecret(const uint8_t* data, size_t size) {
    const std::vector<uint8_t> secret(data, data + size);
    const bool expected = size >= 1 && size <= vigil_tpm::kMaxSecretLength;
    assert(vigil_tpm::IsSecret(secret) == expected && "the secret rule disagrees with its definition");
}

bool ReferenceSplit(const uint8_t* data, size_t size, size_t maxPrivate, size_t maxPublic) {
    if (size < 4) return false;
    const size_t first = data[0] * 256u + data[1];
    if (first == 0 || first > maxPrivate) return false;
    if (2 + first + 2 > size) return false;
    const size_t second = data[2 + first] * 256u + data[3 + first];
    if (second == 0 || second > maxPublic) return false;
    return 2 + first + 2 + second == size;
}

void CheckSplit(const uint8_t* data, size_t size, size_t maxPrivate, size_t maxPublic) {
    vigil_tpm::Span privatePart;
    vigil_tpm::Span publicPart;
    const bool accepted = vigil_tpm::SplitSealed(data, size, maxPrivate, maxPublic, &privatePart, &publicPart);
    assert(accepted == ReferenceSplit(data, size, maxPrivate, maxPublic) && "the split disagrees with the reference");
    if (!accepted) return;

    assert(privatePart.offset == 0 && "the private part does not start the blob");
    assert(publicPart.offset == privatePart.size && "the parts are not contiguous");
    assert(publicPart.offset + publicPart.size == size && "the parts do not cover the blob");
    assert(privatePart.size >= 3 && publicPart.size >= 3 && "a part has no body");
    assert(privatePart.size - 2 <= maxPrivate && "the private part is over its limit");
    assert(publicPart.size - 2 <= maxPublic && "the public part is over its limit");

    const size_t privateBody = data[0] * 256u + data[1];
    const size_t publicBody = data[publicPart.offset] * 256u + data[publicPart.offset + 1];
    assert(privateBody + 2 == privatePart.size && "the private size prefix was misread");
    assert(publicBody + 2 == publicPart.size && "the public size prefix was misread");

    std::vector<uint8_t> rebuilt(data, data + privatePart.size);
    rebuilt.insert(rebuilt.end(), data + publicPart.offset, data + publicPart.offset + publicPart.size);
    assert(rebuilt.size() == size && std::memcmp(rebuilt.data(), data, size) == 0 && "the parts do not rebuild the blob");
}

void CheckFramed(const uint8_t* data, size_t size) {
    if (size < 2) return;
    const size_t first = 1 + data[0] % (size - 1);
    const size_t second = size - first;
    if (second == 0 || first > kRealMaxPrivate || second > kRealMaxPublic) return;

    std::vector<uint8_t> blob;
    blob.push_back(static_cast<uint8_t>(first >> 8));
    blob.push_back(static_cast<uint8_t>(first & 0xFF));
    blob.insert(blob.end(), data, data + first);
    blob.push_back(static_cast<uint8_t>(second >> 8));
    blob.push_back(static_cast<uint8_t>(second & 0xFF));
    blob.insert(blob.end(), data + first, data + size);

    vigil_tpm::Span privatePart;
    vigil_tpm::Span publicPart;
    const bool accepted = vigil_tpm::SplitSealed(blob.data(), blob.size(), kRealMaxPrivate, kRealMaxPublic,
                                                 &privatePart, &publicPart);
    assert(accepted && "a correctly framed blob was refused");
    assert(privatePart.size == first + 2 && publicPart.size == second + 2 && "a framed blob split in the wrong place");
    assert(std::memcmp(blob.data() + 2, data, first) == 0 && "the private body moved");
    assert(std::memcmp(blob.data() + publicPart.offset + 2, data + first, second) == 0 && "the public body moved");
    CheckSplit(blob.data(), blob.size(), kRealMaxPrivate, kRealMaxPublic);

    blob.pop_back();
    assert(!vigil_tpm::SplitSealed(blob.data(), blob.size(), kRealMaxPrivate, kRealMaxPublic, &privatePart, &publicPart) &&
           "a truncated blob was accepted");
    blob.push_back(0);
    blob.push_back(0);
    assert(!vigil_tpm::SplitSealed(blob.data(), blob.size(), kRealMaxPrivate, kRealMaxPublic, &privatePart, &publicPart) &&
           "a blob with trailing bytes was accepted");
}

}  // namespace

extern "C" int LLVMFuzzerTestOneInput(const uint8_t* data, size_t size) {
    CheckScrubBytes(data, size);
    CheckScrubText(data, size);
    CheckPin(data, size);
    CheckSecret(data, size);

    vigil_tpm::Span unused;
    assert(!vigil_tpm::SplitSealed(nullptr, size, kRealMaxPrivate, kRealMaxPublic, &unused, &unused) &&
           "a missing blob was accepted");

    CheckSplit(data, size, kRealMaxPrivate, kRealMaxPublic);
    CheckFramed(data, size);
    if (size > 0) {
        const size_t small = static_cast<size_t>(data[0] % 17);
        CheckSplit(data, size, small, small);
        CheckSplit(data, size, 0xFFFF, 0xFFFF);
    }
    return 0;
}

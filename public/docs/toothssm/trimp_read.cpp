// Reading tooth_ssm's slim archive in C++: scan/<jaw>.tri + labels/<jaw>.trimp -> which tooth each face is.
//
//     g++ -std=c++17 -O2 trimp_read.cpp -lz -o trimp_read
//     ./trimp_read scan/upper.tri labels/upper.trimp [tooth_11.obj 11]
//
// Prints the label counts after checking that the labels belong to this scan (face count and
// fingerprint), and optionally writes the faces of one label (an FDI, or 0 for the gum) as an OBJ.
// Needs only zlib. The formats are specified in deploy/trimp.py (TRIMP v1) and deploy/slim.py (.tri V1);
// both are little-endian, as is every machine this is likely to run on.
#include <zlib.h>

#include <algorithm>
#include <array>
#include <cstdint>
#include <cstdio>
#include <cstring>
#include <fstream>
#include <map>
#include <stdexcept>
#include <string>
#include <vector>

static std::vector<uint8_t> read_file(const char* path) {
    std::ifstream f(path, std::ios::binary);
    if (!f) throw std::runtime_error(std::string("cannot open ") + path);
    return std::vector<uint8_t>((std::istreambuf_iterator<char>(f)), std::istreambuf_iterator<char>());
}

template <class T> static T get(const std::vector<uint8_t>& b, size_t at) {
    if (at + sizeof(T) > b.size()) throw std::runtime_error("file is truncated");
    T v;
    std::memcpy(&v, b.data() + at, sizeof(T));
    return v;
}

// ---------------------------------------------------------------- .tri V1
struct Mesh {
    std::vector<float> v;      // 3 per vertex
    std::vector<uint32_t> f;   // 3 per face
};

static Mesh read_tri(const std::vector<uint8_t>& b) {
    uint32_t nv = get<uint32_t>(b, 0), nf = get<uint32_t>(b, 4);
    if (8 + 12ull * nv + 12ull * nf > b.size()) throw std::runtime_error("not a .tri V1 file, or truncated");
    Mesh m;
    m.v.resize(3ull * nv);
    m.f.resize(3ull * nf);
    std::memcpy(m.v.data(), b.data() + 8, 12ull * nv);
    std::memcpy(m.f.data(), b.data() + 8 + 12ull * nv, 12ull * nf);
    for (uint32_t i : m.f)
        if (i >= nv) throw std::runtime_error("a face uses a vertex the file does not have");
    return m;
}

// ---------------------------------------------------------------- SHA-256 (for the fingerprint)
struct Sha256 {
    uint32_t h[8] = {0x6a09e667, 0xbb67ae85, 0x3c6ef372, 0xa54ff53a, 0x510e527f, 0x9b05688c, 0x1f83d9ab, 0x5be0cd19};
    uint8_t buf[64];
    size_t used = 0;
    uint64_t total = 0;
    static uint32_t ror(uint32_t x, int n) { return (x >> n) | (x << (32 - n)); }
    void block(const uint8_t* p) {
        static const uint32_t k[64] = {
            0x428a2f98, 0x71374491, 0xb5c0fbcf, 0xe9b5dba5, 0x3956c25b, 0x59f111f1, 0x923f82a4, 0xab1c5ed5,
            0xd807aa98, 0x12835b01, 0x243185be, 0x550c7dc3, 0x72be5d74, 0x80deb1fe, 0x9bdc06a7, 0xc19bf174,
            0xe49b69c1, 0xefbe4786, 0x0fc19dc6, 0x240ca1cc, 0x2de92c6f, 0x4a7484aa, 0x5cb0a9dc, 0x76f988da,
            0x983e5152, 0xa831c66d, 0xb00327c8, 0xbf597fc7, 0xc6e00bf3, 0xd5a79147, 0x06ca6351, 0x14292967,
            0x27b70a85, 0x2e1b2138, 0x4d2c6dfc, 0x53380d13, 0x650a7354, 0x766a0abb, 0x81c2c92e, 0x92722c85,
            0xa2bfe8a1, 0xa81a664b, 0xc24b8b70, 0xc76c51a3, 0xd192e819, 0xd6990624, 0xf40e3585, 0x106aa070,
            0x19a4c116, 0x1e376c08, 0x2748774c, 0x34b0bcb5, 0x391c0cb3, 0x4ed8aa4a, 0x5b9cca4f, 0x682e6ff3,
            0x748f82ee, 0x78a5636f, 0x84c87814, 0x8cc70208, 0x90befffa, 0xa4506ceb, 0xbef9a3f7, 0xc67178f2};
        uint32_t w[64];
        for (int i = 0; i < 16; ++i) w[i] = uint32_t(p[4 * i]) << 24 | uint32_t(p[4 * i + 1]) << 16 | uint32_t(p[4 * i + 2]) << 8 | p[4 * i + 3];
        for (int i = 16; i < 64; ++i) {
            uint32_t s0 = ror(w[i - 15], 7) ^ ror(w[i - 15], 18) ^ (w[i - 15] >> 3);
            uint32_t s1 = ror(w[i - 2], 17) ^ ror(w[i - 2], 19) ^ (w[i - 2] >> 10);
            w[i] = w[i - 16] + s0 + w[i - 7] + s1;
        }
        uint32_t a = h[0], b = h[1], c = h[2], d = h[3], e = h[4], f = h[5], g = h[6], hh = h[7];
        for (int i = 0; i < 64; ++i) {
            uint32_t t1 = hh + (ror(e, 6) ^ ror(e, 11) ^ ror(e, 25)) + ((e & f) ^ (~e & g)) + k[i] + w[i];
            uint32_t t2 = (ror(a, 2) ^ ror(a, 13) ^ ror(a, 22)) + ((a & b) ^ (a & c) ^ (b & c));
            hh = g; g = f; f = e; e = d + t1; d = c; c = b; b = a; a = t1 + t2;
        }
        h[0] += a; h[1] += b; h[2] += c; h[3] += d; h[4] += e; h[5] += f; h[6] += g; h[7] += hh;
    }
    void add(const void* data, size_t n) {
        const uint8_t* p = static_cast<const uint8_t*>(data);
        total += n;
        while (n) {
            size_t take = std::min(n, sizeof(buf) - used);
            std::memcpy(buf + used, p, take);
            used += take; p += take; n -= take;
            if (used == 64) { block(buf); used = 0; }
        }
    }
    std::array<uint8_t, 32> done() {
        uint64_t bits = total * 8;
        uint8_t pad = 0x80, zero = 0;
        add(&pad, 1);
        while (used != 56) add(&zero, 1);
        uint8_t len[8];
        for (int i = 0; i < 8; ++i) len[i] = uint8_t(bits >> (56 - 8 * i));
        add(len, 8);
        std::array<uint8_t, 32> out;
        for (int i = 0; i < 8; ++i)
            for (int j = 0; j < 4; ++j) out[4 * i + j] = uint8_t(h[i] >> (24 - 8 * j));
        return out;
    }
};

// The scan's fingerprint: SHA-256 over its triangle corners as float32, face by face, corners in
// stored order (36 bytes a face), first 8 bytes. -0.0 counts as +0.0 (the server writes +0.0).
static std::array<uint8_t, 8> fingerprint(const Mesh& m) {
    Sha256 s;
    for (size_t i = 0; i < m.f.size(); ++i) {     // every corner of every face, in order
        float c[3];
        for (int k = 0; k < 3; ++k) c[k] = m.v[3ull * m.f[i] + k] + 0.0f;
        s.add(c, sizeof c);
    }
    auto full = s.done();
    std::array<uint8_t, 8> fp;
    std::memcpy(fp.data(), full.data(), 8);
    return fp;
}

// ---------------------------------------------------------------- TRIMP v1
static std::vector<uint8_t> read_trimp(const std::vector<uint8_t>& b, const Mesh& scan) {
    if (b.size() < 32 || std::memcmp(b.data(), "TRMP", 4) != 0) throw std::runtime_error("not a TRIMP file");
    uint8_t version = b[4], element = b[5], codec = b[7];
    uint32_t count = get<uint32_t>(b, 8), plen = get<uint32_t>(b, 20), crc = get<uint32_t>(b, 24);
    if (version != 1) throw std::runtime_error("TRIMP version " + std::to_string(version) + "; this reader knows 1");
    if (element != 0) throw std::runtime_error("labels are per vertex; this example reads per-face labels");
    if (count != scan.f.size() / 3)
        throw std::runtime_error("labels are for a scan of " + std::to_string(count) + " faces, this one has " +
                                 std::to_string(scan.f.size() / 3));
    if (std::memcmp(b.data() + 12, fingerprint(scan).data(), 8) != 0)
        throw std::runtime_error("labels are for another scan (fingerprint differs)");
    if (32ull + plen > b.size()) throw std::runtime_error("TRIMP payload is truncated");
    std::vector<uint8_t> labels(count);
    if (codec == 1) {
        uLongf n = count;
        if (uncompress(labels.data(), &n, b.data() + 32, plen) != Z_OK || n != count)
            throw std::runtime_error("TRIMP payload does not inflate to the declared count");
    } else if (codec == 0) {
        if (plen != count) throw std::runtime_error("TRIMP stored payload has the wrong length");
        std::memcpy(labels.data(), b.data() + 32, count);
    } else {
        throw std::runtime_error("unknown TRIMP codec");
    }
    if (crc32(0L, labels.data(), count) != crc) throw std::runtime_error("TRIMP labels fail their CRC-32");
    // Chunks after the payload (tag, uint32 length, data) are optional; skipping them is always allowed.
    return labels;
}

int main(int argc, char** argv) {
    if (argc != 3 && argc != 5) {
        std::fprintf(stderr, "usage: %s scan.tri labels.trimp [out.obj LABEL]\n", argv[0]);
        return 2;
    }
    try {
        Mesh scan = read_tri(read_file(argv[1]));
        std::vector<uint8_t> labels = read_trimp(read_file(argv[2]), scan);
        std::map<int, size_t> n;
        for (uint8_t l : labels) ++n[l];
        std::printf("%zu faces, fingerprint checked\n", labels.size());
        for (auto& [l, c] : n)
            std::printf("  %s %d: %zu faces\n", l == 0 ? "gum" : l == 254 ? "none" : "tooth", l, c);
        if (argc == 5) {
            int want = std::stoi(argv[4]);
            std::vector<int64_t> remap(scan.v.size() / 3, -1);
            std::vector<uint32_t> verts;
            std::string faces;
            for (size_t i = 0; i < labels.size(); ++i) {
                if (labels[i] != want) continue;
                faces += "f";
                for (int k = 0; k < 3; ++k) {
                    uint32_t v = scan.f[3 * i + k];
                    if (remap[v] < 0) { remap[v] = int64_t(verts.size()); verts.push_back(v); }
                    faces += " " + std::to_string(remap[v] + 1);
                }
                faces += "\n";
            }
            std::FILE* o = std::fopen(argv[3], "w");
            if (!o) throw std::runtime_error("cannot write the OBJ");
            for (uint32_t v : verts) std::fprintf(o, "v %.9g %.9g %.9g\n", scan.v[3ull * v], scan.v[3ull * v + 1], scan.v[3ull * v + 2]);
            std::fputs(faces.c_str(), o);
            std::fclose(o);
            std::printf("label %d: %zu vertices -> %s\n", want, verts.size(), argv[3]);
        }
    } catch (const std::exception& e) {
        std::fprintf(stderr, "error: %s\n", e.what());
        return 1;
    }
    return 0;
}

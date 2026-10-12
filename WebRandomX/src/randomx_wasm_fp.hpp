/*
 * randomx_wasm_fp.hpp - the IEEE-754 rounding modes RandomX's CFROUND needs,
 * implemented in software for the WebAssembly build.
 *
 * Why this exists
 * ---------------
 * RandomX's VM has an `fprc` register (specs.md chapter 4.3) that selects the
 * rounding mode of every floating point instruction, and the CFROUND
 * instruction writes it from program state. The mode is part of consensus:
 * FADD_M/FSUB_M/FDIV_M store FP results to the scratchpad, where integer
 * instructions read them back, so the bits a mode produces are hashed.
 *
 * x86-64 implements this with MXCSR (`rx_mxcsr_default | mode << 13`) and
 * aarch64 with FPCR, but WebAssembly has no rounding-mode control at all: every
 * f64 operation rounds to nearest-even, and Emscripten's fesetround() is a stub
 * that changes nothing. A wasm build that ignores the mode therefore disagrees
 * with every other RandomX implementation on almost every hash - not a slower
 * miner, a miner that computes the wrong hash and would have every share
 * rejected. tevador anticipated exactly this in RandomX#81: "It's still
 * possible to implement it in JS/WASM, but with significant performance penalty
 * because of software FP implementation".
 *
 * How it works
 * ------------
 * Every operation below follows the same three steps:
 *
 *   1. the hardware computes the correctly rounded nearest result (wasm
 *      guarantees f64 add/sub/mul/div/sqrt are correctly rounded);
 *   2. the *exact* result is computed in binary128 (clang's `long double` on
 *      wasm32 - every f64 add/sub/mul is exact there, and division/square root
 *      can be compared exactly against the nearest result), which says whether
 *      the exact value is below, equal to or above the nearest double;
 *   3. when the mode is not nearest and the exact value is not representable,
 *      the correctly rounded result is exactly one representable neighbour away
 *      from the nearest result, in the direction the mode asks for - so a single
 *      ulp step finishes the job and no soft-float rounder is needed.
 *
 * binary128 avoids the edge cases that error-free transforms (TwoSum, Dekker
 * products) have for huge or subnormal doubles, and the cost is irrelevant next
 * to the interpreter: a RandomX hash executes roughly 670 of these, about 50 us
 * on top of ~200 ms per browser hash.
 *
 * Specs.md notes that "due to restrictions on the values of the floating point
 * registers, no operation results in NaN or a denormal number", so the flush-to-
 * zero / denormals-are-zero bits of x86's MXCSR never come into play and are not
 * emulated here.
 *
 * Modes are numbered as RandomX's RoundingMode enum (and the MXCSR encoding):
 * 0 = nearest, 1 = down (-inf), 2 = up (+inf), 3 = toward zero.
 */
#ifndef RANDOMX_WASM_FP_HPP
#define RANDOMX_WASM_FP_HPP

#include <cfloat>
#include <cmath>
#include <cstdint>
#include <cstring>

namespace rx_wasm_fp {

/* The current rounding mode. Inline function-local static: C++11 merges it into
 * one entity across the translation units that include this header, which is
 * what lets the patched rx_set_rounding_mode() in instructions_portable.cpp and
 * the patched FP ops in intrin_portable.h share the same state. */
inline uint32_t& mode_slot() {
    static uint32_t mode = 0;
    return mode;
}

inline void reset_float_state() { mode_slot() = 0u; }
inline void set_rounding_mode(uint32_t mode) { mode_slot() = mode & 3u; }
inline uint32_t get_rounding_mode() { return mode_slot(); }

inline uint64_t to_bits(double x) {
    uint64_t b;
    std::memcpy(&b, &x, sizeof(b));
    return b;
}

inline double from_bits(uint64_t b) {
    double x;
    std::memcpy(&x, &b, sizeof(x));
    return x;
}

/* The next representable double in `dir` (+1 toward +inf, -1 toward -inf).
 * Zeros and infinities are handled explicitly because the caller steps from a
 * result that may be either of them. */
inline double neighbour(double x, int dir) {
    if (x != x) return x;                                   /* NaN */
    uint64_t b = to_bits(x);
    const bool negative = (b >> 63) != 0;
    if (dir > 0) {
        if (x == HUGE_VAL) return x;                        /* +inf has no successor */
        if (negative) {
            if (b == 0x8000000000000000ULL) return 0.0;     /* -0 -> +0 */
            b -= 1;
        } else {
            b += 1;
        }
    } else {
        if (x == -HUGE_VAL) return x;                       /* -inf has no predecessor */
        if (!negative) {
            if (b == 0) return -0.0;                        /* +0 -> -0 */
            b -= 1;
        } else {
            b += 1;
        }
    }
    return from_bits(b);
}

/* Adjust a correctly rounded nearest result to the current rounding mode.
 * `rel` is the sign of (exact - nearest) as computed by the caller: -1, 0, +1.
 * `rel == 0` means the exact value was representable, which every mode returns
 * unchanged; NaN and the infinities are mode-independent too. */
inline double to_mode(double nearest, int rel) {
    const uint32_t mode = mode_slot();
    if (mode == 0u || rel == 0 || nearest != nearest) return nearest;
    if (mode == 1u) return rel < 0 ? neighbour(nearest, -1) : nearest;   /* -inf */
    if (mode == 2u) return rel > 0 ? neighbour(nearest, +1) : nearest;   /* +inf */
    /* toward zero: the neighbour that is closer to zero. The sign has to come
     * from the sign bit, not from `< 0.0`: a negative value that underflowed to
     * -0.0 must stay -0.0 here, which `< 0.0` would miss. */
    if ((to_bits(nearest) >> 63) != 0) return rel < 0 ? nearest : neighbour(nearest, +1);
    return rel > 0 ? nearest : neighbour(nearest, -1);
}

/* IEEE 754: a sum that is exactly zero is +0 in every rounding mode except
 * roundTowardNegative, where it is -0 - unless both operands are the same
 * signed zero, in which case -0 + -0 = -0 in every mode. */
inline double zero_sum(double a, double b, double nearest) {
    if (mode_slot() != 1u) return nearest;
    const bool both_zero = (a == 0.0 && b == 0.0);
    const bool same_signed_zero = both_zero && (((to_bits(a) ^ to_bits(b)) >> 63) == 0);
    return same_signed_zero ? nearest : -0.0;
}

inline double max_value() { return DBL_MAX; }

/* --- exactness helpers ------------------------------------------------------
 *
 * Two ways to learn where the exact result sits relative to the nearest double:
 *
 *  - error-free transforms in double precision (Knuth's TwoSum, Dekker's
 *    product): exact for finite operands whose intermediates stay in range, a
 *    handful of f64 operations, ~10 ns;
 *  - the binary128 computation below: exact for every double, but ~120 ns
 *    because wasm has no hardware binary128.
 *
 * The ops use the cheap one and fall back to binary128 in the ranges where it is
 * not exact (magnitudes near the top of the exponent range, subnormal results).
 * RandomX's own WASM work uses the same trick - issue #304 describes "using
 * error free transforms to implement floating point rounding to get around the
 * CFROUND instruction". */

constexpr double splitter = 134217729.0;                    /* 2^27 + 1 */
constexpr double min_normal = 2.2250738585072014e-308;      /* 2^-1022 */

/* The range in which the error-free transforms below are exact.
 *
 * Dekker's product is only exact when none of its intermediates over- or
 * underflows, which needs both operands to sit well inside the exponent range:
 * with |a|, |b| in [2^-400, 2^400] every split part is at least 2^-479, the
 * smallest intermediate (al * bl) is at least 2^-958 - still normal - and the
 * largest is the product itself, at most 2^800. Anything outside falls back to
 * binary128, which is exact unconditionally.
 *
 * 2^+/-400 is a huge window (4e-121 to 2.6e120) that covers every value a
 * RandomX program realistically produces; the fallback exists for the rest. */
/* 2^-400 and 2^400 as exact literals (IEEE bit patterns 0x26F0000000000000 and
 * 0x58F0000000000000). They are compile-time constants on purpose: a
 * dynamically initialised global reads as 0 in a reactor module whose embedder
 * never runs the C++ static constructors, which would silently push every
 * operation onto the slow path instead of the fast one. */
constexpr double eft_lo = 3.87259191484931827e-121;
constexpr double eft_hi = 2.58224987808690859e120;

#if defined(RX_WASM_FP_FORCE_EXACT)
/* Build-time switch for bisecting: with -DRX_WASM_FP_FORCE_EXACT every operation
 * takes the binary128 path, so a hash difference can be attributed to the
 * error-free transforms or to the exact path itself. */
inline bool eft_range(double) { return false; }
#else
inline bool eft_range(double x) {
    const double ax = std::fabs(x);
    return ax >= eft_lo && ax <= eft_hi;
}
#endif

/* A subnormal or zero result means an error term can itself have been rounded
 * away, so those cases take the binary128 path. */
inline bool tiny(double x) { return !(std::fabs(x) >= min_normal); }

/* s = a + b and err = (a + b) - s, both exact, for finite a, b whose sum is in
 * the normal range (Knuth's 2Sum). */
inline void two_sum(double a, double b, double& s, double& err) {
    s = a + b;
    const double bb = s - a;
    err = (a - (s - bb)) + (b - bb);
}

/* (a * b) - p, exact, for finite a, b with |a|, |b| < 2^996 and a normal
 * product (Dekker's split-based product, so no FMA is needed). */
inline double product_error(double a, double b, double p) {
    const double ca = splitter * a;
    const double ah = ca - (ca - a);
    const double al = a - ah;
    const double cb = splitter * b;
    const double bh = cb - (cb - b);
    const double bl = b - bh;
    return ((ah * bh - p) + ah * bl + al * bh) + al * bl;
}

/* Sign of (a - b*r), where p = fl(b*r) and p + e == b*r exactly (e from the
 * product error above) and d = a - p is exact by Sterbenz's lemma because r is
 * a good quotient estimate, so p and a are within a factor of two. Used by
 * division and square root, where what matters is how the exact result compares
 * with the nearest one - a comparison the product error alone cannot make. */
inline int residual_sign(double a, double b, double r) {
    const double p = b * r;
    const double e = product_error(b, r, p);
    const double d = a - p;
    double s, err;
    two_sum(d, -e, s, err);
    if (s > 0.0) return 1;
    if (s < 0.0) return -1;
    return (err > 0.0) - (err < 0.0);
}

/* --- binary128 fallbacks: exact for every double ---------------------------- */

inline double fadd_exact(double a, double b) {
    const double nearest = a + b;
    const long double exact = (long double)a + (long double)b;
    if (exact == 0.0L) return zero_sum(a, b, nearest);
    const long double n = (long double)nearest;
    return to_mode(nearest, (exact > n) - (exact < n));
}

inline double fmul_exact(double a, double b) {
    const double nearest = a * b;
    const long double exact = (long double)a * (long double)b;
    const long double n = (long double)nearest;
    return to_mode(nearest, (exact > n) - (exact < n));
}

inline double fdiv_exact(double a, double b) {
    const double nearest = a / b;
    int rel = 0;
    if (nearest == nearest) {
        /* a - b*nearest = b*(q - nearest) for the exact quotient q, and
         * b*nearest is exact in binary128, so this comparison gives the sign of
         * (q - nearest). NaN comparisons (b == 0, an infinite operand) leave
         * rel = 0, which is right: those quotients are exact or already
         * infinite, and the infinities are mode-independent. */
        const long double br = (long double)b * (long double)nearest;
        const long double la = (long double)a;
        const int s = (br < la) - (br > la);
        rel = (b < 0.0) ? -s : s;
    }
    return to_mode(nearest, rel);
}

inline double fsqrt_exact(double a) {
    const double nearest = std::sqrt(a);        /* correctly rounded by wasm */
    int rel = 0;
    if (nearest == nearest) {                   /* a < 0 or NaN: nothing to fix */
        const long double r2 = (long double)nearest * (long double)nearest;
        const long double la = (long double)a;
        rel = (r2 < la) - (r2 > la);
    }
    return to_mode(nearest, rel);
}

/* --- the five operations RandomX uses --------------------------------------- */

inline double fadd(double a, double b) {
    const double nearest = a + b;
    const uint32_t m = mode_slot();
    if (m == 0u || !std::isfinite(a) || !std::isfinite(b)) return nearest;
    if (!std::isfinite(nearest)) {
        /* Overflow: the exact sum is past the largest finite double, so only
         * "toward +inf" / "toward -inf" keep the infinity. */
        return nearest > 0.0 ? (m == 2u ? nearest : max_value())
                             : (m == 1u ? nearest : -max_value());
    }
    if (tiny(nearest)) return fadd_exact(a, b);
    double s, err;
    two_sum(a, b, s, err);
    return to_mode(nearest, (err > 0.0) - (err < 0.0));
}

/* a - b is a + (-b), and negating a double is exact. */
inline double fsub(double a, double b) { return fadd(a, -b); }

inline double fmul(double a, double b) {
    const double nearest = a * b;
    const uint32_t m = mode_slot();
    if (m == 0u || !std::isfinite(a) || !std::isfinite(b)) return nearest;
    if (!std::isfinite(nearest)) {
        return nearest > 0.0 ? (m == 2u ? nearest : max_value())
                             : (m == 1u ? nearest : -max_value());
    }
    if (!eft_range(a) || !eft_range(b)) return fmul_exact(a, b);
    const double err = product_error(a, b, nearest);
    return to_mode(nearest, (err > 0.0) - (err < 0.0));
}

inline double fdiv(double a, double b) {
    const double nearest = a / b;
    const uint32_t m = mode_slot();
    if (m == 0u || !std::isfinite(a) || !std::isfinite(b)) return nearest;
    if (!eft_range(a) || !eft_range(b) || !eft_range(nearest)) return fdiv_exact(a, b);
    /* residual_sign gives sign(a - b*nearest), and a - b*nearest = b*(q -
     * nearest) for the exact quotient q, so dividing by sign(b) leaves the
     * direction the mode needs. */
    const int s = residual_sign(a, b, nearest);
    return to_mode(nearest, b < 0.0 ? -s : s);
}

inline double fsqrt(double a) {
    const double nearest = std::sqrt(a);
    const uint32_t m = mode_slot();
    if (m == 0u || !std::isfinite(nearest)) return nearest;      /* NaN or +inf */
    if (!eft_range(nearest)) return fsqrt_exact(a);
    /* For non-negative q and r, q - r and q*q - r*r have the same sign, so the
     * sign of (a - nearest^2) - from the exact product p + e - is the direction
     * the mode needs. */
    return to_mode(nearest, residual_sign(a, nearest, nearest));
}

}   /* namespace rx_wasm_fp */

#endif  /* RANDOMX_WASM_FP_HPP */

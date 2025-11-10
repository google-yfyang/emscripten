#include <stdio.h>
#include <stdlib.h>
#include <iostream>

#include "tick.h"
#include "src/__support/FPUtil/FPBits.h"
#include <cstddef>
#include <fstream>

namespace LIBC_NAMESPACE_DECL {
template <typename OutputType, typename InputType> class PerfTest {
public:
using BinaryFuncPtr = OutputType (*)(InputType, InputType);
using UnaryFuncPtr = OutputType (*)(InputType);
using FPBits = fputil::FPBits<OutputType>;
using StorageType = typename FPBits::StorageType;
static constexpr StorageType U_INT_MAX =
    cpp::numeric_limits<StorageType>::max();
template <bool binary, typename Func>
static void run_perf_in_range(Func FuncA, Func FuncB, StorageType startingBit,
                            StorageType endingBit, size_t N, size_t rounds,
                            const char *name_a, const char *name_b,
                            std::ofstream &log) {
if (sizeof(StorageType) <= sizeof(size_t))
    N = std::min(N, static_cast<size_t>(endingBit - startingBit));

auto runner = [=](Func func) {
    [[maybe_unused]] volatile OutputType result;
    if (endingBit < startingBit) {
    return;
    }

    StorageType step = (endingBit - startingBit) / N;
    if (step == 0)
    step = 1;
    for (size_t i = 0; i < rounds; i++) {
    for (StorageType bits_x = startingBit, bits_y = endingBit;;
            bits_x += step, bits_y -= step) {
        InputType x = FPBits(bits_x).get_val();
        if constexpr (binary) {
        InputType y = FPBits(bits_y).get_val();
        result = func(x, y);
        } else {
        result = func(x);
        }
        if (endingBit - bits_x < step) {
        break;
        }
    }
    }
};

tick_t t0 = tick();
runner(FuncA);
tick_t t1 = tick();
auto diff = t1 - t0;

double a_average = static_cast<double>(diff) / N / rounds;
std::cout << "-- Function A: " << name_a << " --\n";
std::cout << "     Total time      : " << diff << " ns \n";
std::cout << "     Average runtime : " << a_average << " ns/op \n";
std::cout << "     Ops per second  : "
    << static_cast<uint64_t>(1'000'000'000.0 / a_average) << " op/s \n";

// timer.start();
// runner(FuncB);
// timer.stop();

// double b_average = static_cast<double>(timer.nanoseconds()) / N / rounds;
// std::cout << "-- Function B: " << name_b << " --\n";
// std::cout << "     Total time      : " << timer.nanoseconds() << " ns \n";
// std::cout << "     Average runtime : " << b_average << " ns/op \n";
// std::cout << "     Ops per second  : "
//     << static_cast<uint64_t>(1'000'000'000.0 / b_average) << " op/s \n";

// std::cout << "-- Average ops per second ratio --\n";
// std::cout << "     A / B  : " << b_average / a_average << " \n";
}


template <bool binary, typename Func>
static void run_perf(Func FuncA, Func FuncB, int rounds, const char *name_a,
                    const char *name_b, const char *logFile) {
std::ofstream log(logFile);
std::cout << " Performance tests with inputs in denormal range:\n";
run_perf_in_range<binary>(
    FuncA, FuncB, /* startingBit= */ StorageType(0),
    /* endingBit= */ FPBits::max_subnormal().uintval(), 1'000'001, rounds,
    name_a, name_b, log);
std::cout << "\n Performance tests with inputs in normal range:\n";
run_perf_in_range<binary>(FuncA, FuncB,
                            /* startingBit= */ FPBits::min_normal().uintval(),
                            /* endingBit= */ FPBits::max_normal().uintval(),
                            1'000'001, rounds, name_a, name_b, log);
std::cout << "\n Performance tests with inputs in normal range with exponents "
        "close to each other:\n";
run_perf_in_range<binary>(
    FuncA, FuncB,
    /* startingBit= */ FPBits(OutputType(0x1.0p-10)).uintval(),
    /* endingBit= */ FPBits(OutputType(0x1.0p+10)).uintval(), 1'000'001,
    rounds, name_a, name_b, log);
}

template <bool binary>
static void run(UnaryFuncPtr FuncA, UnaryFuncPtr FuncB, const char *name_a, const char *name_b, const char* filename){
    run_perf<binary>(
        FuncA,                                    
        FuncB, 1, name_a, name_b, filename); 
}
template <bool binary>
static void run(BinaryFuncPtr FuncA, BinaryFuncPtr FuncB, const char *name_a, const char *name_b, const char* filename){
    run_perf<binary>(
        FuncA,                                    
        FuncB, 1, name_a, name_b, filename); 
}
};
}

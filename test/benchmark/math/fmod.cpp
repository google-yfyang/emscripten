#include "math_benchmark_util.h"

int main(int argc, char **argv)
{
    LIBC_NAMESPACE::PerfTest<double, double>::run<true>(&fmod, &fmod, "fmod", "fmod", "fmod_perf.log");
    return 0;
}
#include "math_benchmark_util.h"

int main(int argc, char **argv)
{
    LIBC_NAMESPACE::PerfTest<float, float>::run<false>(&sqrtf, &sqrtf, "sqrtf", "sqrtf", "sqrtf_perf.log");
    return 0;
}
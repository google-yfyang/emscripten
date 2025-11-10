#include "math_benchmark_util.h"

int main(int argc, char **argv)
{
    LIBC_NAMESPACE::PerfTest<float, float>::run<false>(&expf, &expf, "expf", "expf", "expf_perf.log");
    return 0;
}
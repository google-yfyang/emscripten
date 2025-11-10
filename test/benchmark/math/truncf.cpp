#include "math_benchmark_util.h"

int main(int argc, char **argv)
{
    LIBC_NAMESPACE::PerfTest<float, float>::run<false>(&truncf, &truncf, "truncf", "truncf", "truncf_perf.log");
    return 0;
}
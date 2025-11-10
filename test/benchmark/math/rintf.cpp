#include "math_benchmark_util.h"

int main(int argc, char **argv)
{
    LIBC_NAMESPACE::PerfTest<float, float>::run<false>(&rintf, &rintf, "rintf", "rintf", "rintf_perf.log");
    return 0;
}
#include "math_benchmark_util.h"

int main(int argc, char **argv)
{
    LIBC_NAMESPACE::PerfTest<double, double>::run<false>(&log10, &log10, "log10", "log10", "log10_perf.log");
    return 0;
}
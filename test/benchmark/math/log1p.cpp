#include "math_benchmark_util.h"

int main(int argc, char **argv)
{
    LIBC_NAMESPACE::PerfTest<double, double>::run<false>(&log1p, &log1p, "log1p", "log1p", "log1p_perf.log");
    return 0;
}
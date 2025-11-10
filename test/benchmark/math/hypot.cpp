#include "math_benchmark_util.h"

int main(int argc, char **argv)
{
    LIBC_NAMESPACE::PerfTest<double, double>::run<true>(&hypot, &hypot, "hypot", "hypot", "hypot_perf.log");
    return 0;
}
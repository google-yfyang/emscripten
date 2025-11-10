#include "math_benchmark_util.h"

int main(int argc, char **argv)
{
    LIBC_NAMESPACE::PerfTest<double, double>::run<false>(&tan, &tan, "tan", "tan", "tan_perf.log");
    return 0;
}
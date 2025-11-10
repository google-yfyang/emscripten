#include "math_benchmark_util.h"

int main(int argc, char **argv)
{
    LIBC_NAMESPACE::PerfTest<double, double>::run<false>(&sin, &sin, "sin", "sin", "sin_perf.log");
    return 0;
}
#include "math_benchmark_util.h"

int main(int argc, char **argv)
{
    LIBC_NAMESPACE::PerfTest<double, double>::run<false>(&cos, &cos, "cos", "cos", "cos_perf.log");
    return 0;
}
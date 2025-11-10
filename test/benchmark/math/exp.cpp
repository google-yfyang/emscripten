#include "math_benchmark_util.h"

int main(int argc, char **argv)
{
    LIBC_NAMESPACE::PerfTest<double, double>::run<false>(&exp, &exp, "exp", "exp", "exp_perf.log");
    return 0;
}
#include "math_benchmark_util.h"

int main(int argc, char **argv)
{
    LIBC_NAMESPACE::PerfTest<float, float>::run<false>(&logf, &logf, "logf", "logf", "logf_perf.log");
    return 0;
}
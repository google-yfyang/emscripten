#include "math_benchmark_util.h"

int main(int argc, char **argv)
{
    LIBC_NAMESPACE::PerfTest<float, float>::run<false>(&sinf, &sinf, "sinf", "sinf", "sinf_perf.log");
    return 0;
}
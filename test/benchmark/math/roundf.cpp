#include "math_benchmark_util.h"

int main(int argc, char **argv)
{
    LIBC_NAMESPACE::PerfTest<float, float>::run<false>(&roundf, &roundf, "roundf", "roundf", "roundf_perf.log");
    return 0;
}
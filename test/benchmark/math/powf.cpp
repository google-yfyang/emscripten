#include "math_benchmark_util.h"

int main(int argc, char **argv)
{
    LIBC_NAMESPACE::PerfTest<float, float>::run<true>(&powf, &powf, "powf", "powf", "powf_perf.log");
    return 0;
}
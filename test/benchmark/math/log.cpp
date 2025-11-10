#include "math_benchmark_util.h"

int main(int argc, char **argv)
{
    LIBC_NAMESPACE::PerfTest<double, double>::run<false>(&log, &log, "log", "log", "log_perf.log");
    return 0;
}
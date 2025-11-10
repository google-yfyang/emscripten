#include "src/setjmp/sigsetjmp.h"
#include "hdr/offsetof_macros.h"
#include "src/__support/common.h"

namespace LIBC_NAMESPACE_DECL {
[[gnu::returns_twice]] int sigsetjmp(jmp_buf sigjmp_buf, [[maybe_unused]] int savesigs) {
    return setjmp(sigjmp_buf);
}
}

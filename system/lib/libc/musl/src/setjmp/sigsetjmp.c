#include <setjmp.h>

int sigsetjmp(jmp_buf sigjmp_buf, int savesigs) {
    return setjmp(sigjmp_buf);
}

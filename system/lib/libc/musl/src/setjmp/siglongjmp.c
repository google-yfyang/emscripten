#include <setjmp.h>

_Noreturn void siglongjmp(jmp_buf buf, int val) {
   longjmp(buf, val);
}

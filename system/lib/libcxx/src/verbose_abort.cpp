//===----------------------------------------------------------------------===//
//
// Part of the LLVM Project, under the Apache License v2.0 with LLVM Exceptions.
// See https://llvm.org/LICENSE.txt for license information.
// SPDX-License-Identifier: Apache-2.0 WITH LLVM-exception
//
//===----------------------------------------------------------------------===//

#include <__config>
#include <__verbose_abort>
#include <cstdarg>
#include <cstdio>
#include <cstdlib>
#include <cstring>

#ifdef __BIONIC__
#  include <syslog.h>
extern "C" void android_set_abort_message(const char* msg);
#endif   // __BIONIC__

#if defined(__APPLE__) && __has_include(<CrashReporterClient.h>)
#  include <CrashReporterClient.h>
#endif

_LIBCPP_BEGIN_NAMESPACE_STD

_LIBCPP_WEAK void __libcpp_verbose_abort(char const* format, ...) _LIBCPP_VERBOSE_ABORT_NOEXCEPT {
  // Write message to stderr. We do this before formatting into a
  // buffer so that we still get some information out if that fails.
  {
    va_list list;
    va_start(list, format);
    std::vfprintf(stderr, format, list);
    // TODO(sbc): Add newline here unconditionally. libc++ seems inconsistent about strings
    // passed to __libcpp_verbose_abort. The _LIBCPP_VERBOSE_ABORT macro seems to never use
    // newlines, but _LIBCPP_ASSERTION_HANDLER does include a newline.
    if (format[strlen(format) - 1] != '\n') {
      std::fputc('\n', stderr);
    }
    va_end(list);
  }

  // Format the arguments into an allocated buffer for CrashReport & friends.
  // We leak the buffer on purpose, since we're about to abort() anyway.
  char* buffer;
  (void)buffer;
  va_list list;
  va_start(list, format);

#if defined(__APPLE__) && __has_include(<CrashReporterClient.h>)
  // Note that we should technically synchronize accesses here (by e.g. taking a lock),
  // however concretely we're only setting a pointer, so the likelihood of a race here
  // is low.
  vasprintf(&buffer, format, list);
  CRSetCrashLogMessage(buffer);
#elif defined(__BIONIC__)
  vasprintf(&buffer, format, list);

  // Show error in tombstone.
  android_set_abort_message(buffer);

  // Show error in logcat.
  openlog("libc++", 0, 0);
  syslog(LOG_CRIT, "%s", buffer);
  closelog();
#endif
  va_end(list);

  std::abort();
}

_LIBCPP_END_NAMESPACE_STD

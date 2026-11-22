// `~/.local/bin/localbox`: the bytes AgentSetup copies from `Localbox.app/Contents/Resources/bin/localbox`. It
// holds the launch lock shared for the CLI's whole life, so an update (which holds it exclusively while it replaces
// the bundle) never runs a half-replaced CLI, then runs the CLI inside the app.
#include <sys/file.h>
#include <sys/stat.h>
#include <errno.h>
#include <fcntl.h>
#include <limits.h>
#include <pwd.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <unistd.h>

// The one source of the lock's path under the account home; the app's Info.plist key
// `LocalboxLaunchLockRelativePath` is written from the same value.
#ifndef LOCALBOX_LAUNCH_LOCK_RELATIVE_PATH
#define LOCALBOX_LAUNCH_LOCK_RELATIVE_PATH "Library/Caches/sh.localbox.mac/launch.lock"
#endif
// Tests build with a scratch account home and Applications folder; a release build never overrides them.
#ifndef LOCALBOX_SYSTEM_APPLICATIONS
#define LOCALBOX_SYSTEM_APPLICATIONS "/Applications"
#endif

// AgentSetup recognises an earlier Localbox launcher by this mark, so an updated launcher replaces it while a file
// someone else put at `~/.local/bin/localbox` is left alone.
__attribute__((used)) static const char mark[] = "sh.localbox.launcher";

// The CLI's failure envelope (packages/contract), so a caller parsing `--json` reads the refusal like any other.
static int fail(const char *code, const char *message, int retryable, int status) {
    printf("{\"protocol_version\":\"v1\",\"request_id\":\"launcher\",\"operation\":\"launcher\",\"sandbox_id\":null,"
           "\"release_id\":\"localbox-contract-v1\",\"ok\":false,\"error\":{\"code\":\"%s\",\"message\":\"%s\",\"retryable\":%s}}\n",
           code, message, retryable ? "true" : "false");
    fprintf(stderr, "%s: %s\n", code, message);
    return status;
}

// Each directory on the way to the lock must be a real directory this user owns, never a link someone planted.
static int directory(const char *path) {
    if (mkdir(path, 0700) != 0 && errno != EEXIST) return -1;
    struct stat info;
    if (lstat(path, &info) != 0 || !S_ISDIR(info.st_mode) || info.st_uid != getuid()) return -1;
    return 0;
}

static int prepare(const char *home, char *lock, size_t size) {
    if (snprintf(lock, size, "%s/%s", home, LOCALBOX_LAUNCH_LOCK_RELATIVE_PATH) >= (int)size) return -1;
    // Create every parent below the home, one component at a time.
    for (char *slash = lock + strlen(home) + 1; (slash = strchr(slash, '/')); ++slash) {
        *slash = '\0';
        int made = directory(lock);
        *slash = '/';
        if (made != 0) return -1;
    }
    return 0;
}

static int bundle(const char *path) {
    struct stat info;
    return stat(path, &info) == 0 && S_ISDIR(info.st_mode);
}

int main(int argc, char **argv) {
    (void)argc;
    // The lock lives in the account's real home, not $HOME: the updater holds it there, and a CLI run with another
    // HOME must still be excluded.
#ifdef LOCALBOX_ACCOUNT_HOME
    const char *account = LOCALBOX_ACCOUNT_HOME;
#else
    struct passwd *entry = getpwuid(getuid());
    const char *account = entry && entry->pw_dir && *entry->pw_dir ? entry->pw_dir : NULL;
    if (!account) return fail("internal", "Cannot resolve this account's home folder", 0, 74);
#endif
    char lock[PATH_MAX], app[PATH_MAX], cli[PATH_MAX];
    if (prepare(account, lock, sizeof(lock)) != 0) return fail("internal", "Cannot prepare the Localbox launch lock folder", 0, 74);
    // Not close-on-exec: the CLI inherits the descriptor, so the shared lock lasts until the CLI exits.
    int fd = open(lock, O_CREAT | O_RDWR | O_NOFOLLOW, 0600);
    struct stat info, named;
    if (fd < 0 || fstat(fd, &info) != 0 || lstat(lock, &named) != 0 || !S_ISREG(info.st_mode) || info.st_uid != getuid() ||
        info.st_nlink != 1 || (info.st_mode & 077) != 0 || info.st_dev != named.st_dev || info.st_ino != named.st_ino)
        return fail("internal", "The Localbox launch lock is not a private file owned by this user", 0, 74);
    if (flock(fd, LOCK_SH | LOCK_NB) != 0) {
        if (errno == EWOULDBLOCK) return fail("conflict", "Localbox is updating; try again in a moment", 1, 75);
        return fail("internal", "Cannot take the Localbox launch lock", 0, 74);
    }
    char descriptor[32];
    snprintf(descriptor, sizeof(descriptor), "%d", fd);
    setenv("LOCALBOX_LAUNCH_LOCK_FD", descriptor, 1);
    setenv("LOCALBOX_LAUNCH_LOCK", lock, 1);

    // Nothing in the replaceable bundle is touched before the shared lock is held.
    const char *chosen = getenv("LOCALBOX_APP"), *home = getenv("HOME");
    if (!home || !*home) home = account;
    int fits;
    if (chosen && *chosen) fits = snprintf(app, sizeof(app), "%s", chosen) < (int)sizeof(app);
    else {
        fits = snprintf(app, sizeof(app), "%s/Applications/Localbox.app", home) < (int)sizeof(app);
        if (fits && !bundle(app)) fits = snprintf(app, sizeof(app), "%s/Localbox.app", LOCALBOX_SYSTEM_APPLICATIONS) < (int)sizeof(app);
    }
    if (!fits || snprintf(cli, sizeof(cli), "%s/Contents/Resources/cli/localbox", app) >= (int)sizeof(cli))
        return fail("internal", "The Localbox.app path is too long", 0, 74);
    if (access(cli, X_OK) != 0)
        return fail("internal", "Localbox.app was not found in ~/Applications or /Applications; install it, or set LOCALBOX_APP to its path", 0, 69);
    // A CLI this one starts finds the same app.
    setenv("LOCALBOX_APP", app, 1);
    argv[0] = cli;
    execv(cli, argv);
    return fail("internal", "The CLI inside Localbox.app could not start; reinstall Localbox", 0, 74);
}

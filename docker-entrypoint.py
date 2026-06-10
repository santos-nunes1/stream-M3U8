import os
import pwd
import grp
import sys


def chown_tree(path: str, uid: int, gid: int) -> None:
    if not os.path.exists(path):
        os.makedirs(path, exist_ok=True)
    for root, dirs, files in os.walk(path):
        try:
            os.chown(root, uid, gid)
        except OSError:
            continue
        for name in dirs:
            try:
                os.chown(os.path.join(root, name), uid, gid)
            except OSError:
                continue
        for name in files:
            try:
                os.chown(os.path.join(root, name), uid, gid)
            except OSError:
                continue


def main() -> None:
    user = pwd.getpwnam("app")
    group = grp.getgrnam("app")
    for path in ("/app/data", "/app/bot-data", "/tmp/stream-buffer"):
        chown_tree(path, user.pw_uid, group.gr_gid)

    os.setgid(group.gr_gid)
    os.setuid(user.pw_uid)
    command = sys.argv[1:] or ["python", "-m", "backend.app"]
    os.execvp(command[0], command)


if __name__ == "__main__":
    main()

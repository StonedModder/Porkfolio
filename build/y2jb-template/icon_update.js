async function start_icon_update() {

  function read_file_to_buffer(path) {
    const path_addr = alloc_string(path);
    const stat_buf = malloc(0x200n);
    const stat_ret = syscall(SYSCALL.stat, path_addr, stat_buf);
    if (stat_ret !== 0n) {
      throw new Error("read_file_to_buffer: stat failed for " + path + " code: " + toHex(stat_ret));
    }
    const file_size = Number(read64(stat_buf + 72n)); // 0x48 offset for st_size

    if (file_size < 0) {
      throw new Error("read_file_to_buffer: invalid file size " + file_size);
    }
    if (file_size === 0) { // empty file
        return { buffer: malloc(0n), size: 0 };
    }

    const fd = syscall(SYSCALL.open, path_addr, O_RDONLY, 0n);
    if (fd < 0n) {
      throw new Error("read_file_to_buffer: open failed for " + path + " fd: " + toHex(fd));
    }

    const file_buffer = malloc(BigInt(file_size));

    try {
      const bytes_read = syscall(SYSCALL.read, fd, file_buffer, BigInt(file_size));

      if (bytes_read < 0n) {
        throw new Error("read_file_to_buffer: read failed: " + toHex(bytes_read));
      }
      if (Number(bytes_read) !== file_size) {
        throw new Error(`read_file_to_buffer: incomplete read. Expected ${file_size}, got ${bytes_read}`);
      }
    } finally {
      syscall(SYSCALL.close, fd);
    }

    return { buffer: file_buffer, size: file_size }; // Return size as number
  }

  function write_buffer_to_file(path, buffer_ptr, size) {
      const path_addr = alloc_string(path);
      // flags: O_WRONLY|O_CREAT|O_TRUNC, mode 0755
      const flags = O_WRONLY | O_CREAT | O_TRUNC;
      const mode = 0o755n;
      const fd = syscall(SYSCALL.open, path_addr, BigInt(flags), mode);
      if (fd < 0n) {
          const err = toHex(fd);
          log("[ERROR] open for write failed: " + path + " fd=" + err);
          send_notification("[ERROR] open for write failed: " + path + " fd=" + err);
          return false;
      }

      // Write directly from the provided buffer pointer
      const wrote = syscall(SYSCALL.write, fd, buffer_ptr, BigInt(size));
      const closeRet = syscall(SYSCALL.close, fd);

      if (wrote < 0n) {
          const err = toHex(wrote);
          log("[ERROR] write failed for " + path + " -> " + err);
          send_notification("[ERROR] write failed for " + path + " -> " + err);
          return false;
      }
      if (wrote !== BigInt(size)) {
          log("[WARN] partial write for " + path + " wrote=" + wrote + " expected=" + size);
          send_notification("[WARN] partial write for " + path + " wrote=" + wrote + " expected=" + size);
          return false;
      }
      if (closeRet < 0n) {
          log("[WARN] close returned " + toHex(closeRet) + " for " + path);
          send_notification("[WARN] close returned " + toHex(closeRet) + " for " + path);
      }
      return true;
  }

  function compare_buffers(buf1_ptr, buf2_ptr, size) {
      const n = BigInt(size);
      for (let i = 0n; i < n; i++) {
          if (read8(buf1_ptr + i) !== read8(buf2_ptr + i)) {
              return false; // Buffers are different
          }
      }
      return true; // Buffers are identical
  }

  function file_exists(path) {
    const path_addr = alloc_string(path);
    const stat_buf = malloc(0x200n);
    const ret = syscall(SYSCALL.stat, path_addr, stat_buf);
    return ret === 0n;
  }

  async function updateIcon() {
    const iconPath = "/user/appmeta/" + get_title_id() + "/icon0.png";
    const newIconPath = "/mnt/sandbox/" + get_title_id() + "_000/download0/cache/splash_screen/aHR0cHM6Ly93d3cueW91dHViZS5jb20vdHY=/icon0.png";

    if (!file_exists(iconPath)) {
        log("Icon file does not exist: " + iconPath);
        return null;
    }

    let currentIcon = null;
    let newIcon = null;
    let areIdentical = false;

    try {
        log("Reading current icon from: " + iconPath);
        currentIcon = read_file_to_buffer(iconPath);
        log("Current icon size: " + currentIcon.size + " bytes");

        log("Reading new icon from: " + newIconPath);
        newIcon = read_file_to_buffer(newIconPath);
        log("New icon size: " + newIcon.size + " bytes");

        if (currentIcon.size !== newIcon.size) {
            log("Icons are different (size mismatch).");
            areIdentical = false;
        } else {
            log("Icons are the same size. Comparing contents...");
            areIdentical = compare_buffers(currentIcon.buffer, newIcon.buffer, currentIcon.size);
        }

        if (!areIdentical) {
            log("Icons are different. Updating icon...");
            const writeSuccess = write_buffer_to_file(iconPath, newIcon.buffer, newIcon.size);
            if (writeSuccess) {
                log("Icon updated successfully at: " + iconPath);
                send_notification("Icon updated successfully.");
            } else {
                log("Failed to update icon at: " + iconPath);
            }
        } else {
            log("Icons are identical. No update needed.");
        }

    } catch (e) {
        const msg = (e && e.message) ? e.message : String(e);
        log("[ERROR] updateIcon failed: " + msg);
        send_notification("[ERROR] updateIcon: " + msg);
    }
  }

  await updateIcon();

}


async function start_autoload() {

  const AUTOLOAD_DIRNAME = "ps5_autoloader";

  function sceNetHtons(hostshort) {
    return ((hostshort & 0xff) << 8) | ((hostshort >> 8) & 0xff);
  }

  function read_string_from_buffer(address, length) {
    let str = "";
    for (let i = 0; i < length; i++) {
      const charCode = Number(read8(address + BigInt(i)));
      str += String.fromCharCode(charCode);
    }
    return str;
  }

  function read_file_to_buffer(path) {
    const path_addr = alloc_string(path);
    const stat_buf = malloc(0x200n);
    if (syscall(SYSCALL.stat, path_addr, stat_buf) !== 0n) {
      throw new Error("read_file_to_buffer: stat failed for " + path);
    }
    const file_size = Number(read64(stat_buf + 72n));
    if (file_size <= 0) {
      throw new Error("read_file_to_buffer: invalid file size " + file_size);
    }

    const fd = syscall(SYSCALL.open, path_addr, O_RDONLY, 0n);
    if (fd < 0n) {
      throw new Error("read_file_to_buffer: open failed for " + path + " fd: " + toHex(fd));
    }

    const file_buffer = malloc(BigInt(file_size));
    let total_bytes_read = 0n;

    try {
      const bytes_read = syscall(SYSCALL.read, fd, file_buffer, BigInt(file_size));
      total_bytes_read = bytes_read;

      if (bytes_read < 0n) {
        throw new Error("read_file_to_buffer: read failed: " + toHex(bytes_read));
      }
      if (Number(bytes_read) !== file_size) {
        throw new Error(`read_file_to_buffer: incomplete read. Expected ${file_size}, got ${bytes_read}`);
      }
    } finally {
      syscall(SYSCALL.close, fd);
    }

    return { buffer: file_buffer, size: file_size };
  }



  function read_file(path) {
    const path_addr = alloc_string(path);
    const fd = syscall(SYSCALL.open, path_addr, O_RDONLY, 0n);

    if (fd === 0xffffffffffffffffn || fd < 0n) {
      throw new Error("read_file: open failed for " + path + " fd: " + toHex(fd));
    }

    let file_chunks = []; // Use an array to store chunks
    const chunk_size = 4096; // Read in 4KB chunks
    const buffer = malloc(BigInt(chunk_size));

    try {
      while (true) {
        const bytes_read = syscall(SYSCALL.read, fd, buffer, BigInt(chunk_size));
        const n = Number(bytes_read);

        if (bytes_read === 0xffffffffffffffffn) {
          throw new Error("read_file: read failed: " + toHex(bytes_read));
        }

        if (n <= 0) {
          // End of file
          break;
        }

        file_chunks.push(read_string_from_buffer(buffer, n));
      }
    } finally {
      syscall(SYSCALL.close, fd);
    }

    return file_chunks.join('');
  }



  function file_exists(path) {
    const path_addr = alloc_string(path);
    const stat_buf = malloc(0x200n);
    const ret = syscall(SYSCALL.stat, path_addr, stat_buf);
    return ret === 0n;
  }


  function sleep(ms) {
    return new Promise((resolve) => setTimeout(resolve, ms));
  }


  class ElfSender {
    constructor(filepath, elf_buffer, elf_size) {
      this.filepath = filepath;
      this.elf_buffer = elf_buffer;
      this.elf_size = elf_size;
    }

    static async loadFromFile(filepath) {
      if (!file_exists(filepath)) {
        const msg = "[-] File not found: " + filepath;
        log(msg);
        send_notification(msg);
        throw new Error(msg);
      }

      log("Loading elf from: " + filepath);

      const { buffer, size } = read_file_to_buffer(filepath);
      log("elf size: " + size);

      return new ElfSender(filepath, buffer, size);
    }


    async sendToLocalhost(port) {
      await log(`Attempting to send ${this.elf_size} bytes to 127.0.0.1:${port}`);

      const sockfd = syscall(SYSCALL.socket, AF_INET, SOCK_STREAM, 0n);
      await log("Socket fd: " + toHex(sockfd));
      if (sockfd < 0n) {
        throw new Error("socket creation failed: " + toHex(sockfd));
      }

      const enable = malloc(4n);
      write32(enable, 1n);
      syscall(SYSCALL.setsockopt, sockfd, SOL_SOCKET, SO_REUSEADDR, enable, 4n);

      // Prepare sockaddr for 127.0.0.1:port
      const sockaddr = malloc(16n);
      write8(sockaddr + 0n, 16n); // sin_len
      write8(sockaddr + 1n, AF_INET); // sin_family
      write16(sockaddr + 2n, BigInt(sceNetHtons(port))); // sin_port
      write8(sockaddr + 4n, 127n); // 127.0.0.1
      write8(sockaddr + 5n, 0n);
      write8(sockaddr + 6n, 0n);
      write8(sockaddr + 7n, 1n);
      // Padding 8-15 is 0

      // Connect to the loader
      const connect_ret = syscall(SYSCALL.connect, sockfd, sockaddr, 16n);
      if (connect_ret < 0n) {
        const msg = "[-] connect failed: " + toHex(connect_ret);
        await log(msg);
        send_notification(msg);
        syscall(SYSCALL.close, sockfd);
        return;
      }

      await log("Connected to loader. Writing ELF data...");

      const data_len = BigInt(this.elf_size);

      const total_sent = syscall(SYSCALL.write, sockfd, this.elf_buffer, data_len);
      syscall(SYSCALL.close, sockfd);

      if (total_sent < 0n) {
        const msg = "[-] error sending elf data to localhost: " + toHex(total_sent);
        await log(msg);
        send_notification(msg);
        return;
      }

      const msg = `Successfully sent ${total_sent} bytes to loader`;
      await log(msg);
      send_notification(msg);
    }
  }

  async function loadElf(path) {
    try {
      const elf = await ElfSender.loadFromFile(path);
      await elf.sendToLocalhost(9021);
    } catch (e) {
      log("ElfSender Error: " + e.message);
    }
  }


  function load_javascript_from_string(js_code) {
      const codeString = js_code;
      const func = new Function(codeString);
      func();
  }


  const autoLoadPaths = [];


  // if you want to use multiple YT apps from different regions,
  // name your directory ps5_autoloader_[TITLE_ID], e.g. ps5_autoloader_PPSA01650
  // this will allow you to have different autoload.txt files for each app
  // (these directories always take precedence over the generic ps5_autoloader directory)

  for (let i = 0; i <= 7; i++) {
    autoLoadPaths.push(`/mnt/usb${i}/${AUTOLOAD_DIRNAME}_${get_title_id()}/autoload.txt`);
  }
  autoLoadPaths.push(`/data/${AUTOLOAD_DIRNAME}_${get_title_id()}/autoload.txt`);

  for (let i = 0; i <= 7; i++) {
    autoLoadPaths.push(`/mnt/usb${i}/${AUTOLOAD_DIRNAME}/autoload.txt`);
  }
  autoLoadPaths.push(`/data/${AUTOLOAD_DIRNAME}/autoload.txt`);
  autoLoadPaths.push(`/mnt/sandbox/${get_title_id()}_000/download0/cache/splash_screen/aHR0cHM6Ly93d3cueW91dHViZS5jb20vdHY=/${AUTOLOAD_DIRNAME}/autoload.txt`);

  // Check each path in order and use the first one that exists
  let autoLoadConfigPath = null;
  for (const path of autoLoadPaths) {
    if (file_exists(path)) {
      autoLoadConfigPath = path;
      break;
    }
  }

  async function process_autoload_config() {
  if (autoLoadConfigPath) {
    log("Found autoload config at: " + autoLoadConfigPath);
    send_notification("Found autoload config at: " + autoLoadConfigPath);
    const configDir = autoLoadConfigPath.substring(0, autoLoadConfigPath.lastIndexOf('/') + 1);
    const configContent = read_file(autoLoadConfigPath);
    const lines = configContent.split('\n');

    let num_payloads = 0;
    let has_elfs = false;

    for (const line of lines) {
      const trimmedLine = line.trim();
      if (trimmedLine.length === 0 || trimmedLine.startsWith('#')) {
        continue;
      }
      if (trimmedLine.startsWith('!')) {
        // sleep
      } else if (trimmedLine.startsWith('@')) {
        // notification
      } else if (trimmedLine === 'elfldr.elf') {
        has_elfs = true;
      } else if (trimmedLine.endsWith('.elf') || trimmedLine.endsWith('.bin')) {
        num_payloads++;
        has_elfs = true;
      } else if (trimmedLine.endsWith('.js')) {
        num_payloads++;
      }
    }

    window.autoload_steps_total = num_payloads + (has_elfs ? 1 : 0);
    window.autoload_steps_done = 0;

    window.increment_autoload_progress = function(message) {
        if (window.autoload_steps_total > 0) {
            window.autoload_steps_done++;
            let progress = 50 + (window.autoload_steps_done / window.autoload_steps_total) * 50;
            if (progress > 100) progress = 100;
            if (typeof window.updateProgress === 'function') {
                window.updateProgress(progress, message);
            }
        }
    };

    for (const line of lines) {
      const trimmedLine = line.trim();

      if (trimmedLine.length === 0 || trimmedLine.startsWith('#')) {
        continue;
      }

      log("Processing line: " + trimmedLine);

      if (trimmedLine.startsWith('!')) {
        const sleepTimeStr = trimmedLine.substring(1).trim();
        const sleepTime = parseInt(sleepTimeStr, 10);
        if (!isNaN(sleepTime) && sleepTime > 0) {
          log("Sleeping for " + sleepTime + " ms");
          await sleep(sleepTime);
        } else {
          const errorMsg = "Invalid sleep time: " + sleepTimeStr;
          log("[ERROR] " + errorMsg);
          send_notification("[ERROR] " + errorMsg);
        }
      } else if (trimmedLine.startsWith('@')) {
        // notification command
        let notificationMsg = trimmedLine.substring(1).trim();
        // replace "\n" with actual newlines
        notificationMsg = notificationMsg.replace(/\\n/g, '\n');
        send_notification(notificationMsg);
      } else if (trimmedLine.endsWith('.elf') || trimmedLine.endsWith('.bin')) {
        const fullPath = trimmedLine.startsWith('/') ? trimmedLine : configDir + trimmedLine;
        if (file_exists(fullPath)) {
          log("Loading ELF from: " + fullPath);
          send_notification("Loading ELF from: " + fullPath);
          await loadElf(fullPath);
          if (typeof window.increment_autoload_progress === 'function') {
              window.increment_autoload_progress("Loaded " + trimmedLine);
          }
        } else {
          const errorMsg = "File not found: " + fullPath;
          log("[ERROR] " + errorMsg);
          send_notification("[ERROR] " + errorMsg);
        }
      } else if (trimmedLine.endsWith('.js')) {
        const fullPath = trimmedLine.startsWith('/') ? trimmedLine : configDir + trimmedLine;
        if (file_exists(fullPath)) {
          log("Executing JS from: " + fullPath);
          send_notification("Executing JS from: " + fullPath);
          try {
            const jsContent = read_file(fullPath);
            load_javascript_from_string(jsContent);
            if (typeof window.increment_autoload_progress === 'function') {
                window.increment_autoload_progress("Executed " + trimmedLine);
            }
          } catch (e) {
            const errorMsg = "Failed to execute JS: " + fullPath;
            log("[ERROR] " + errorMsg + " - " + e.message);
            send_notification("[ERROR] " + errorMsg + "\n" + e.message);
          }
        } else {
          const errorMsg = "File not found: " + fullPath;
          log("[ERROR] " + errorMsg);
          send_notification("[ERROR] " + errorMsg);
        }
      } else {
        const errorMsg = "Unsupported file type: " + trimmedLine;
        log("[ERROR] " + errorMsg);
        send_notification("[ERROR] " + errorMsg);
      }
    }
  } else {
    log("No autoload config found in any location");
    send_notification("No autoload config found in any location");
  }

  }

  // wait for elf_loader to start accepting connections
  let loader_active = false;
  for (let i = 0; i < 50; i++) {
    const sockfd = syscall(SYSCALL.socket, AF_INET, SOCK_STREAM, 0n);
    if (sockfd >= 0n) {
      const enable = malloc(4n);
      write32(enable, 1n);
      syscall(SYSCALL.setsockopt, sockfd, SOL_SOCKET, SO_REUSEADDR, enable, 4n);

      // Prepare sockaddr for 127.0.0.1:9021
      const sockaddr = malloc(16n);
      write8(sockaddr + 0n, 16n); // sin_len
      write8(sockaddr + 1n, AF_INET); // sin_family
      write16(sockaddr + 2n, BigInt(sceNetHtons(9021))); // sin_port
      write8(sockaddr + 4n, 127n); // 127.0.0.1
      write8(sockaddr + 5n, 0n);
      write8(sockaddr + 6n, 0n);
      write8(sockaddr + 7n, 1n);

      const connect_ret = syscall(SYSCALL.connect, sockfd, sockaddr, 16n);
      syscall(SYSCALL.close, sockfd);

      if (connect_ret >= 0n) {
        loader_active = true;
        break;
      }
    }
    await sleep(200);
  }

  if (!loader_active) {
    await log("[ERROR] autoloader: elf_loader is not active");
  }

  await process_autoload_config();

}

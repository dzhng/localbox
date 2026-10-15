# Vendored from Duet commit 8f3cb100e016e2627618718675b2617d8b98f2aa.
ARG BASE_IMAGE=boldsoftware/exeuntu
ARG BUN_VERSION=1.3.14
ARG GATEWAY_BUN_VERSION=1.4.2
ARG GATEWAY_BUN_SHA256=36368faef7527875d5ffa52e53cd48021741f2a83eb6208a8dd64068d422a913

# --- final: the runtime image the VM boots ---
FROM ${BASE_IMAGE}
ARG BUN_VERSION
ARG GATEWAY_BUN_VERSION
ARG GATEWAY_BUN_SHA256
USER root
ENV DEBIAN_FRONTEND=noninteractive

# System packages. Mirrors the toolchain the E2B user-sandbox template installs
# (see chat-app/packages/sandbox-build) so agents have the same CLIs here,
# including LibreOffice's headless conversion components. This reverses the
# recorded ~331MB size-based drop: pptx/xlsx→pdf have no mature
# LibreOffice-free path, so capability beats image size while staging.
# Base image already ships git/gh/ripgrep/python3, but listing them is harmless.
# Syncthing is NOT apt-installed — it is a SHA-pinned official release below
# (MAP-SYNC V1); the unpinned apt package auto-upgrades and phones home.
RUN apt-get update \
  && apt-get install -y --no-install-recommends \
    build-essential \
    ca-certificates \
    catfish \
    cmake \
    curl \
    devilspie2 \
    ffmpeg \
    fonts-inter \
    fonts-noto-color-emoji \
    fonts-noto-core \
    gh \
    ghostscript \
    git \
    imagemagick \
    jq \
    libcairo2 \
    libcups2 \
    libgl1 \
    libreoffice-calc-nogui \
    libreoffice-core-nogui \
    libreoffice-draw-nogui \
    libreoffice-impress-nogui \
    libreoffice-writer-nogui \
    libvips-tools \
    libxinerama1 \
    libxrandr2 \
    libxrender1 \
    ninja-build \
    pandoc \
    plank \
    poppler-utils \
    pulseaudio \
    pulseaudio-utils \
    python-is-python3 \
    qpdf \
    ripgrep \
    tesseract-ocr \
    thunar \
    unzip \
    vim \
    wget \
    x11-utils \
    xclip \
    xfce4-panel \
    xfce4-session \
    xfce4-settings \
    xfce4-terminal \
    xfdesktop4 \
    xfwm4 \
    dbus-x11 \
    openssl \
    xz-utils \
    zip \
  && rm -f /etc/systemd/user/default.target.wants/pulseaudio.service \
    /etc/systemd/user/sockets.target.wants/pulseaudio.socket \
  && rm -rf /var/lib/apt/lists/*

# WhiteSur's release sources are pinned and verified before the image adopts
# their prebuilt XFCE/GTK theme or installs the icon set. Keeping the archive
# pins here makes the desktop as reproducible as the browser and VNC packages.
ARG WHITESUR_GTK_VERSION=2026-08-08
ARG WHITESUR_GTK_SHA256=6397235ce2c6ac4b96691f73bb6b9090c94c4cd4a105c2fdbcaa3a9680fefeab
ARG WHITESUR_ICON_VERSION=2026-08-11
ARG WHITESUR_ICON_SHA256=70c1b1b89854655ba054793c1a1e7359842e6f1c3f5320920f715af63bcd75b1
# Plank positions its indicator from LineWidth; WhiteSur's zero leaves the
# running dot half outside an edge-anchored dock.
RUN curl -fsSL -o /tmp/whitesur-gtk.tar.gz \
      "https://codeload.github.com/vinceliuice/WhiteSur-gtk-theme/tar.gz/refs/tags/${WHITESUR_GTK_VERSION}" \
  && echo "${WHITESUR_GTK_SHA256}  /tmp/whitesur-gtk.tar.gz" | sha256sum -c - \
  && curl -fsSL -o /tmp/whitesur-icons.tar.gz \
      "https://codeload.github.com/vinceliuice/WhiteSur-icon-theme/tar.gz/refs/tags/${WHITESUR_ICON_VERSION}" \
  && echo "${WHITESUR_ICON_SHA256}  /tmp/whitesur-icons.tar.gz" | sha256sum -c - \
  && mkdir -p /tmp/whitesur-gtk /tmp/whitesur-icons \
    /usr/share/themes /usr/share/icons /usr/share/plank/themes/WhiteSur \
    /usr/share/doc/whitesur-gtk-theme /usr/share/doc/whitesur-icon-theme \
  && tar -xzf /tmp/whitesur-gtk.tar.gz -C /tmp/whitesur-gtk --strip-components=1 \
  && tar -xzf /tmp/whitesur-icons.tar.gz -C /tmp/whitesur-icons --strip-components=1 \
  && tar -xJf /tmp/whitesur-gtk/release/WhiteSur-Light-solid.tar.xz -C /usr/share/themes \
  && bash /tmp/whitesur-icons/install.sh -d /usr/share/icons -t default \
  && cp /usr/share/themes/WhiteSur-Light-solid/plank/dock.theme \
    /usr/share/plank/themes/WhiteSur/dock.theme \
  && sed -i \
    -e 's/^LineWidth=0$/LineWidth=4/' \
    -e 's/^FillEndColor=209;;209;;209;;150$/FillEndColor=209;;209;;209;;50/' \
    /usr/share/plank/themes/WhiteSur/dock.theme \
  && cp /tmp/whitesur-gtk/COPYING /usr/share/doc/whitesur-gtk-theme/copyright \
  && cp /tmp/whitesur-icons/COPYING /usr/share/doc/whitesur-icon-theme/copyright \
  && test -f /usr/share/themes/WhiteSur-Light-solid/xfwm4/themerc \
  && test -f /usr/share/themes/WhiteSur-Light-solid/plank/dock.theme \
  && grep -Fx 'LineWidth=4' /usr/share/plank/themes/WhiteSur/dock.theme \
  && test -f /usr/share/icons/WhiteSur/index.theme \
  && rm -rf /tmp/whitesur-gtk.tar.gz /tmp/whitesur-icons.tar.gz \
    /tmp/whitesur-gtk /tmp/whitesur-icons

# Syncthing: pinned, SHA-verified official release (MAP-SYNC V1). Replaces the
# unpinned apt package — which auto-upgrades (breaking the event-shape pin) and
# registers with discovery/relays on first boot. The version + digest move
# together with the Mac bundle (slice 22); bump only on a security advisory or a
# gated minor. The binary itself must never self-upgrade: STNOUPGRADE in the
# service unit + autoUpgradeIntervalH=0 in the hardened config.
ARG SYNCTHING_VERSION=v2.1.2
ARG SYNCTHING_SHA256=0cea24660ac7d8df19f01da979827b5c9463a8a60042e296829293cf80213ee4
RUN curl -fsSL -o /tmp/syncthing.tar.gz \
      "https://github.com/syncthing/syncthing/releases/download/${SYNCTHING_VERSION}/syncthing-linux-amd64-${SYNCTHING_VERSION}.tar.gz" \
  && echo "${SYNCTHING_SHA256}  /tmp/syncthing.tar.gz" | sha256sum -c - \
  && tar -xzf /tmp/syncthing.tar.gz -C /tmp \
  && install -m 0755 "/tmp/syncthing-linux-amd64-${SYNCTHING_VERSION}/syncthing" /usr/bin/syncthing \
  && rm -rf /tmp/syncthing.tar.gz "/tmp/syncthing-linux-amd64-${SYNCTHING_VERSION}" \
  && syncthing --version

# static-web-server: pinned, SHA-verified official GNU/Linux release. This is
# the only static server baked into the image; build-apps commands rely on its
# CLI contract for both ordinary static roots and SPA page fallback.
ARG STATIC_WEB_SERVER_VERSION=v2.43.0
ARG STATIC_WEB_SERVER_SHA256=da3c4e599d6bb2bf6d3aebb2a97c7ebdae842896cadafec97792b96a595bf5aa
RUN curl -fsSL -o /tmp/static-web-server.tar.gz \
      "https://github.com/static-web-server/static-web-server/releases/download/${STATIC_WEB_SERVER_VERSION}/static-web-server-${STATIC_WEB_SERVER_VERSION}-x86_64-unknown-linux-gnu.tar.gz" \
  && echo "${STATIC_WEB_SERVER_SHA256}  /tmp/static-web-server.tar.gz" | sha256sum -c - \
  && tar -xzf /tmp/static-web-server.tar.gz -C /tmp \
  && install -m 0755 "/tmp/static-web-server-${STATIC_WEB_SERVER_VERSION}-x86_64-unknown-linux-gnu/static-web-server" /usr/bin/static-web-server \
  && rm -rf /tmp/static-web-server.tar.gz "/tmp/static-web-server-${STATIC_WEB_SERVER_VERSION}-x86_64-unknown-linux-gnu" \
  && static-web-server --version \
  && static-web-server --help | grep -- --page-fallback \
  && static-web-server --help | grep -- --port \
  && static-web-server --help | grep -- --root

# KasmVNC: the noble package matches the exeuntu base and is verified before
# apt resolves its runtime dependencies. The desktop stays inert until the
# gateway explicitly starts it.
ARG KASMVNC_VERSION=1.5.0
ARG KASMVNC_SHA256=f599fe02e2175b9817b6165f74a5d2bebdc73118dde9181ba3410963bed7ae1e
RUN curl -fsSL -o /tmp/kasmvncserver.deb \
      "https://github.com/kasmtech/KasmVNC/releases/download/v${KASMVNC_VERSION}/kasmvncserver_noble_${KASMVNC_VERSION}_amd64.deb" \
  && echo "${KASMVNC_SHA256}  /tmp/kasmvncserver.deb" | sha256sum -c - \
  && apt-get update \
  && apt-get install -y --no-install-recommends /tmp/kasmvncserver.deb \
  && rm -f /tmp/kasmvncserver.deb \
  && rm -rf /var/lib/apt/lists/*

# Google Chrome: exact-version and SHA pinned. The .deb's maintainer script
# installs Google's apt source and daily repair job; both are removed after the
# direct install so a background apt run cannot replace the binary underneath
# the one shared browser process.
ARG GOOGLE_CHROME_VERSION=151.0.7922.137-1
ARG GOOGLE_CHROME_SHA256=e6dabf044cf9cd0279cfe86efa431682c18bfc06d06339ce055aaa87ae871727
RUN curl -fsSL -o /tmp/google-chrome-stable.deb \
      "https://dl.google.com/linux/chrome/deb/pool/main/g/google-chrome-stable/google-chrome-stable_${GOOGLE_CHROME_VERSION}_amd64.deb" \
  && echo "${GOOGLE_CHROME_SHA256}  /tmp/google-chrome-stable.deb" | sha256sum -c - \
  && apt-get update \
  && apt-get install -y --no-install-recommends /tmp/google-chrome-stable.deb \
  && apt-mark hold google-chrome-stable \
  && rm -f /tmp/google-chrome-stable.deb \
    /etc/apt/sources.list.d/google-chrome.list \
    /etc/apt/sources.list.d/google-chrome.sources \
    /etc/cron.daily/google-chrome \
    /opt/google/chrome/cron/google-chrome \
    /usr/share/applications/com.google.Chrome.desktop \
    /usr/share/applications/google-chrome.desktop \
    /usr/share/applications/xfce4-web-browser.desktop \
  && rm -rf /var/lib/apt/lists/*

# Raise the inotify watch ceiling for dev-tree scale (MAP-SYNC K4/L21): the
# default (~8k) silently degrades Syncthing's watcher on a node_modules-sized
# drive into full periodic rescans.
RUN printf 'fs.inotify.max_user_watches=204800\n' > /etc/sysctl.d/60-duet-syncthing.conf

# Node.js 24 from NodeSource (brings a bundled npm). Ubuntu's apt `nodejs` is
# 18.x (EOL) and trips EBADENGINE on modern agent CLIs; install the current
# major instead of the distro package.
RUN curl -fsSL https://deb.nodesource.com/setup_24.x | bash - \
  && apt-get install -y --no-install-recommends nodejs \
  && rm -rf /var/lib/apt/lists/*

# Python packages, installed system-wide. E2B installs these on a python base
# image; Ubuntu's system python is PEP-668 externally-managed, so we pass
# --break-system-packages (the Ubuntu analog of that e2b-specific base image).
RUN python3 -m pip install --no-cache-dir --break-system-packages \
    CairoSVG \
    imageio \
    'markitdown[all]' \
    matplotlib \
    'moviepy<2' \
    numpy \
    openpyxl \
    pandas \
    pdf2image \
    pdfplumber \
    Pillow \
    pillow-heif \
    playwright \
    pypandoc \
    pypdf \
    pytesseract \
    PyYAML \
    python-docx \
    python-pptx \
    reportlab \
    requests

# General workspace tools are baked into the image at build time.
# Duet is delivered through the shared runtime inventory.
RUN npm install -g \
    eslint \
    firecrawl-cli \
    prettier \
    skills \
    typescript

RUN mkdir -p /home/exedev/.bun /home/exedev/.duet /home/exedev/drive /home/exedev/.vnc/pki \
    /home/exedev/.config/autostart /home/exedev/.config/devilspie2 \
    /home/exedev/.config/plank/dock1/launchers \
    /home/exedev/.config/xfce4/xfconf/xfce-perchannel-xml \
    /usr/share/backgrounds /opt/duet/bin \
  && openssl req -x509 -nodes -newkey rsa:2048 -days 3650 \
    -subj '/CN=duet-desktop' \
    -keyout /home/exedev/.vnc/pki/desktop.key \
    -out /home/exedev/.vnc/pki/desktop.crt \
  && chmod 600 /home/exedev/.vnc/pki/desktop.key \
  && chmod 644 /home/exedev/.vnc/pki/desktop.crt \
  && chown -R exedev:exedev /home/exedev /opt/duet

COPY --chown=exedev:exedev packages/vm-image/desktop/kasmvnc.yaml /home/exedev/.vnc/kasmvnc.yaml
COPY packages/vm-image/desktop/kasmvnc-branding.css /usr/share/kasmvnc/www/duet-branding.css
COPY apps/web/public/icons/duet-avatar.png /usr/share/kasmvnc/www/duet-avatar.png
COPY packages/vm-image/desktop/duet-browser.desktop /usr/share/applications/duet-browser.desktop
COPY packages/vm-image/desktop/duet-wallpaper.svg /usr/share/backgrounds/duet-wallpaper.svg
COPY --chown=exedev:exedev packages/vm-image/desktop/xfce4/ /home/exedev/.config/xfce4/xfconf/xfce-perchannel-xml/
COPY --chown=exedev:exedev packages/vm-image/desktop/autostart/ /home/exedev/.config/autostart/
COPY --chown=exedev:exedev packages/vm-image/desktop/devilspie2/ /home/exedev/.config/devilspie2/
COPY --chown=exedev:exedev packages/vm-image/desktop/plank/ /home/exedev/.config/plank/dock1/launchers/
COPY packages/vm-image/scripts/start-desktop-style.sh /opt/duet/bin/start-desktop-style.sh
COPY packages/vm-image/scripts/start-shared-chrome.sh /opt/duet/bin/start-shared-chrome
COPY packages/vm-image/scripts/update-shared-chrome.sh /opt/duet/bin/update-shared-chrome
COPY --chown=exedev:exedev packages/vm-image/desktop/chrome-extension/ /opt/duet/browser-extension/source/
RUN mkdir -p /etc/opt/chrome/policies/managed \
  && chown exedev:exedev /opt/duet/browser-extension \
  && mv /opt/duet/browser-extension/source/signing-key.pem /tmp/duet-browser-extension-key.pem \
  && runuser -u exedev -- env HOME=/home/exedev timeout 30s /usr/bin/google-chrome-stable \
    --no-sandbox --disable-gpu \
    --pack-extension=/opt/duet/browser-extension/source \
    --pack-extension-key=/tmp/duet-browser-extension-key.pem \
  && mv /opt/duet/browser-extension/source.crx /opt/duet/browser-extension/extension.crx \
  && rm -f /tmp/duet-browser-extension-key.pem \
  && printf '%s\n' \
    '{"ExtensionInstallForcelist":["afenalibcinabapjicfjhoikjdaanllp;http://127.0.0.1:3000/v1/desktop/browser-extension/update.xml"]}' \
    > /etc/opt/chrome/policies/managed/duet-browser-extension.json \
  && chmod 644 /opt/duet/browser-extension/extension.crx \
    /etc/opt/chrome/policies/managed/duet-browser-extension.json
RUN for page in /usr/share/kasmvnc/www/index.html /usr/share/kasmvnc/www/vnc.html; do \
      sed -i \
        -e 's#<title>KasmVNC</title>#<title>Duet</title>#g' \
        -e 's#KasmVNC encountered an error:#Duet encountered an error:#g' \
        -e 's#Enable KasmVNC Keyboard Shortcuts#Enable desktop keyboard shortcuts#g' \
        -e 's#href="\./assets/368_kasm_logo_only_[^"]*\.png"#href="./duet-avatar.png"#g' \
        -e 's#<div id="noVNC_transition">#<div id="noVNC_transition"><div id="duet_desktop_brand"><img src="./duet-avatar.png" alt=""><span>Duet Desktop</span></div>#g' \
        -e 's#</head>#<link rel="stylesheet" href="./duet-branding.css"></head>#' \
        "$page"; \
    done \
  && grep -F '<title>Duet</title>' /usr/share/kasmvnc/www/index.html >/dev/null \
  && grep -F 'href="./duet-branding.css"' /usr/share/kasmvnc/www/index.html >/dev/null \
  && grep -F '<span>Duet Desktop</span>' /usr/share/kasmvnc/www/index.html >/dev/null \
  && ! grep -F 'href="./assets/368_kasm_logo_only_' /usr/share/kasmvnc/www/index.html \
  && ! grep -F 'KasmVNC encountered an error:' /usr/share/kasmvnc/www/index.html \
  && cairosvg /usr/share/backgrounds/duet-wallpaper.svg \
      -o /usr/share/backgrounds/duet-wallpaper.png \
      --output-width 1440 --output-height 900 \
  && identify /usr/share/backgrounds/duet-wallpaper.png | grep -F '1440x900' \
  && test "$(identify -format '%k' /usr/share/backgrounds/duet-wallpaper.png)" -gt 256 \
  && chmod 755 /opt/duet/bin/start-desktop-style.sh /opt/duet/bin/start-shared-chrome \
    /opt/duet/bin/update-shared-chrome
USER exedev
ENV BUN_INSTALL=/home/exedev/.bun
ENV PATH=/home/exedev/.bun/bin:$PATH
RUN set -eu \
  && password="$(openssl rand -base64 24)" \
  && printf '%s\n%s\n' "$password" "$password" | /usr/bin/kasmvncpasswd -u duet -w \
  && /usr/bin/kasmvncserver -select-de xfce :1 -disableBasicAuth \
  && /usr/bin/kasmvncserver -kill :1 \
  && test -x /home/exedev/.vnc/xstartup \
  && grep -F 'exec xfce4-session' /home/exedev/.vnc/xstartup \
  && rm -f /home/exedev/.kasmpasswd /home/exedev/.vnc/*.log /home/exedev/.vnc/*.pid
RUN curl -fsSL https://bun.sh/install | bash -s -- "bun-v${BUN_VERSION}"
# Gateway stream finalization needs the newer runtime; agent PGlite concurrency
# is verified separately on the workspace runtime. Keep the gateway bin off PATH.
RUN curl -fsSL "https://github.com/oven-sh/bun/releases/download/bun-v${GATEWAY_BUN_VERSION}/bun-linux-x64.zip" -o /tmp/gateway-bun.zip \
  && echo "${GATEWAY_BUN_SHA256}  /tmp/gateway-bun.zip" | sha256sum -c - \
  && unzip -q /tmp/gateway-bun.zip -d /tmp/gateway-bun \
  && install -Dm755 /tmp/gateway-bun/bun-linux-x64/bun /opt/duet/gateway-runtime/bin/bun \
  && rm -rf /tmp/gateway-bun /tmp/gateway-bun.zip

# Exact shared constructor output; application installation never uses npm.
COPY --chown=exedev:exedev runtime/ /opt/duet/

USER root
# Login shells and systemd resolve the same managed CLI; workspace Bun stays on PATH.
RUN ln -s /opt/duet/current/duet /usr/local/bin/duet \
  && printf '%s\n' 'export BUN_INSTALL=/home/exedev/.bun' 'export PATH="/home/exedev/.bun/bin:$PATH"' \
    > /etc/profile.d/duet-path.sh \
  && chmod 644 /etc/profile.d/duet-path.sh
COPY packages/vm-image/scripts/syncthing-harden.sh /opt/duet/bin/syncthing-harden.sh
COPY packages/vm-image/scripts/ensure-kasm-credentials.sh /opt/duet/bin/ensure-kasm-credentials.sh
RUN chmod 755 /opt/duet/bin/syncthing-harden.sh /opt/duet/bin/ensure-kasm-credentials.sh

COPY systemd/duet-gateway.service /etc/systemd/system/duet-gateway.service
COPY systemd/duet-syncthing.service /etc/systemd/system/duet-syncthing.service
COPY systemd/duet-desktop.service /etc/systemd/system/duet-desktop.service
COPY systemd/duet-desktop-browser.service /etc/systemd/system/duet-desktop-browser.service
COPY systemd/duet-desktop.target /etc/systemd/system/duet-desktop.target
COPY packages/vm-image/scripts/stop-shared-chrome.py /opt/duet/bin/stop-shared-chrome.py
RUN chmod 755 /opt/duet/bin/stop-shared-chrome.py
COPY packages/vm-image/scripts/duet-browser /usr/local/bin/duet-browser
RUN chmod 755 /usr/local/bin/duet-browser
COPY --chmod=0440 sudoers/duet-desktop /etc/sudoers.d/duet-desktop
RUN mkdir -p /etc/systemd/system/multi-user.target.wants \
  && ln -sf /etc/systemd/system/duet-gateway.service /etc/systemd/system/multi-user.target.wants/duet-gateway.service \
  && ln -sf /etc/systemd/system/duet-syncthing.service /etc/systemd/system/multi-user.target.wants/duet-syncthing.service \
  && chown -R exedev:exedev /home/exedev/.duet /home/exedev/drive

EXPOSE 3000
CMD ["/sbin/init"]

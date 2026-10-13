#!/bin/sh

LOCALBOX_PATH_BLOCK_START='# >>> localbox >>>'
LOCALBOX_PATH_BLOCK_END='# <<< localbox <<<'

localbox_startup_files() {
  case "${SHELL##*/}" in
    bash) printf '%s\n' .bash_profile .bash_login .profile .bashrc ;;
    zsh|'') printf '%s\n' .zshenv .zprofile .zshrc ;;
    *) printf '%s\n' .profile ;;
  esac
}

localbox_login_files() {
  case "${SHELL##*/}" in
    bash) printf '%s\n' .bash_profile .bash_login .profile ;;
    zsh|'') printf '%s\n' .zshenv .zprofile ;;
    *) : ;;
  esac
}

localbox_path_covered() {
  local file line
  while IFS= read -r file; do
    [ -f "$HOME/$file" ] || continue
    while IFS= read -r line || [ -n "$line" ]; do
      case "$line" in
        \#*) ;;
        *PATH*\.local/bin*) return 0 ;;
      esac
    done < "$HOME/$file"
  done <<EOF
$(localbox_login_files)
EOF
  return 1
}

localbox_add_path() {
  local target contents file
  if localbox_path_covered; then return 0; fi
  case "${SHELL##*/}" in
    bash)
      target=.bash_profile
      for file in .bash_profile .bash_login .profile; do
        if [ -e "$HOME/$file" ]; then target=$file; break; fi
      done
      ;;
    zsh|'') target=.zprofile ;;
    *) return 0 ;;
  esac
  mkdir -p "$HOME"
  contents=''
  if [ -e "$HOME/$target" ]; then
    contents=$(cat "$HOME/$target") || return 1
  fi
  {
    printf '%s' "$contents"
    [ -z "$contents" ] || printf '\n'
    printf '%s\n' "$LOCALBOX_PATH_BLOCK_START" 'export PATH="$HOME/.local/bin:$PATH"' "$LOCALBOX_PATH_BLOCK_END"
  } > "$HOME/$target.localbox-installing"
  if [ -e "$HOME/$target" ]; then chmod "$(stat -f %Lp "$HOME/$target")" "$HOME/$target.localbox-installing"; fi
  mv "$HOME/$target.localbox-installing" "$HOME/$target"
}

localbox_remove_path() {
  local file mode
  while IFS= read -r file; do
    [ -f "$HOME/$file" ] || continue
    mode=$(stat -f %Lp "$HOME/$file") || continue
    awk -v start="$LOCALBOX_PATH_BLOCK_START" -v end="$LOCALBOX_PATH_BLOCK_END" '
      $0 == start { drop = 1; next }
      $0 == end { drop = 0; next }
      !drop { print }
    ' "$HOME/$file" > "$HOME/$file.localbox-removing"
    chmod "$mode" "$HOME/$file.localbox-removing"
    mv "$HOME/$file.localbox-removing" "$HOME/$file"
  done <<EOF
$(localbox_startup_files)
EOF
}

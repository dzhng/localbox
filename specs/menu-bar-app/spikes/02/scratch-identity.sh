#!/bin/sh
# A throwaway self-signed code-signing identity in a scratch keychain, for check 8 when the keychain's own scratch
# identity ("Agent Computer Local") cannot sign without a click on a keychain dialog.
#
#   scratch-identity.sh <dir>     creates <dir>/spike.keychain-db holding "Localbox Spike 02 Scratch"
#
# The keychain is never added to the search list (codesign is given it with --keychain) and goes away with <dir>.
# The login keychain is not touched. This is not a release key and is never used outside the spike.
set -eu
dir=${1:?usage: scratch-identity.sh <dir>}
name="Localbox Spike 02 Scratch"
mkdir -p "$dir"; chmod 700 "$dir"
password=$(openssl rand -hex 24)
cat > "$dir/openssl.cnf" <<EOF
[req]
distinguished_name = dn
x509_extensions = ext
prompt = no
[dn]
CN = $name
[ext]
basicConstraints = critical,CA:false
keyUsage = critical,digitalSignature
extendedKeyUsage = critical,codeSigning
EOF
openssl req -x509 -newkey rsa:2048 -nodes -days 2 -config "$dir/openssl.cnf" -keyout "$dir/key.pem" -out "$dir/cert.pem" >/dev/null 2>&1
openssl pkcs12 -export -inkey "$dir/key.pem" -in "$dir/cert.pem" -name "$name" -passout "pass:$password" -out "$dir/identity.p12" >/dev/null 2>&1
security create-keychain -p "$password" "$dir/spike.keychain-db" >/dev/null
security set-keychain-settings "$dir/spike.keychain-db"
security unlock-keychain -p "$password" "$dir/spike.keychain-db"
security import "$dir/identity.p12" -k "$dir/spike.keychain-db" -P "$password" -T /usr/bin/codesign >/dev/null
security set-key-partition-list -S apple-tool:,apple:,codesign: -s -k "$password" "$dir/spike.keychain-db" >/dev/null
rm -f "$dir/key.pem" "$dir/identity.p12"
echo "$dir/spike.keychain-db"

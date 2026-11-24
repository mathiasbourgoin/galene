"""Add a password-file option to an upstream galene-stt checkout."""
from pathlib import Path
import sys

source = Path(sys.argv[1]) / "galene-stt.go"
code = source.read_text()
old = "\tflag.Parse()\n"
new = """\tvar passwordFile string
\tflag.StringVar(&passwordFile, "password-file", "", "read the password from a private file")
\tflag.Parse()
\tif passwordFile != "" {
\t\tsecret, err := os.ReadFile(passwordFile)
\t\tif err != nil {
\t\t\tlog.Fatal(err)
\t\t}
\t\tpassword = strings.TrimSpace(string(secret))
\t}
"""
if new in code:
    sys.exit(0)
if code.count(old) != 1:
    sys.exit("Cannot identify galene-stt's flag parser")
source.write_text(code.replace(old, new))

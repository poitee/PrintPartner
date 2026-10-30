import importlib.util, os, pytest
spec = importlib.util.spec_from_file_location("ld", os.path.join(os.path.dirname(__file__), "lane-dispatch.py"))
ld = importlib.util.module_from_spec(spec); spec.loader.exec_module(ld)

def test_per_vm_token_wins(tmp_path):
    f = tmp_path / "t"; f.write_text("filetok\n")
    env = {"T3_TOKEN_133": "a", "T3_TOKEN_134": "b", "T3_TOKEN": "shared", "T3_TOKEN_FILE": str(f)}
    assert ld.t3_token("133", env) == "a" and ld.t3_token("134", env) == "b"
    assert ld.t3_token("135", env) == "shared"
    assert ld.t3_token("136", {"T3_TOKEN_FILE": str(f), "T3_TOKEN_136": " "}) == "filetok"

def test_missing_token_names_var_not_value():
    with pytest.raises(KeyError) as e: ld.t3_token("135", {"T3_TOKEN_133": "secretval"})
    assert "T3_TOKEN_135" in str(e.value) and "secretval" not in str(e.value)

def test_parse_rpc_json_and_sse():
    assert ld.parse_rpc('{"jsonrpc":"2.0","id":1,"result":{"ok":1}}')["result"]["ok"] == 1
    assert ld.parse_rpc('event: message\ndata: {"jsonrpc":"2.0","id":1,"result":{"ok":2}}\n\n')["result"]["ok"] == 2

def test_parse_rpc_error_raises_without_body():
    with pytest.raises(RuntimeError) as e: ld.parse_rpc('{"jsonrpc":"2.0","id":1,"error":{"code":-32001,"message":"tok abc"}}')
    assert "-32001" in str(e.value) and "abc" not in str(e.value)

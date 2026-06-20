import sys
sys.path.insert(0, "Backend")
from fastapi.testclient import TestClient
import api

c = TestClient(api.app)
r = c.post("/workspace/reset")
print("POST reset (no auth) ->", r.status_code)
paths = [getattr(rt, "path", "") for rt in api.app.routes if getattr(rt, "path", "").startswith("/work")]
print("registered routes:", paths)

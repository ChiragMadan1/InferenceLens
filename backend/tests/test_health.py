def test_health(client):
    response = client.get("/health")
    assert response.status_code == 200
    assert response.json() == {"status": "ok"}


# Pattern to follow for feature tests, e.g. tests/test_items.py — `client`
# and an isolated in-memory DB come from the `client` fixture in conftest.py:
#
# def test_create_item(client):
#     response = client.post("/items", json={"name": "widget", "created_by": 1})
#     assert response.status_code == 201
#
# def test_create_item_empty_name_rejected(client):
#     response = client.post("/items", json={"name": "", "created_by": 1})
#     assert response.status_code == 422

import http from "node:http";

function listen(server) {
  return new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      if (!address || typeof address === "string")
        reject(new Error("No TCP port."));
      else resolve(address.port);
    });
  });
}

function html(body, script = "") {
  return `<!doctype html>
<html lang="en">
<head><meta charset="utf-8"><meta name="viewport" content="width=device-width"><title>FlowCode Stage 3 fixture</title>
<style>body{font:16px system-ui;max-width:760px;margin:32px auto;padding:0 20px}form{display:grid;gap:12px}label{display:grid;gap:4px}button,input,select{font:inherit;padding:8px}iframe{width:100%;height:130px;border:1px solid #aaa;margin-top:16px}.actions{display:flex;gap:8px;flex-wrap:wrap}</style></head>
<body>${body}<script>${script}</script></body></html>`;
}

let secondaryPort = 0;
const primary = http.createServer((request, response) => {
  const url = new URL(request.url ?? "/", "http://127.0.0.1");
  if (url.pathname === "/download") {
    response.writeHead(200, {
      "content-type": "text/plain",
      "content-disposition": "attachment; filename=flowcode-fixture.txt",
    });
    response.end("FlowCode browser download fixture\n");
    return;
  }
  if (url.pathname === "/popup") {
    response.writeHead(200, { "content-type": "text/html; charset=utf-8" });
    response.end(
      html(
        "<h1>Popup target</h1><button id='popup-action'>Popup action</button>",
      ),
    );
    return;
  }
  if (url.pathname === "/same-frame") {
    response.writeHead(200, { "content-type": "text/html; charset=utf-8" });
    response.end(
      html("<label>Same-origin frame <input id='same-frame-input'></label>"),
    );
    return;
  }
  response.writeHead(200, { "content-type": "text/html; charset=utf-8" });
  response.end(
    html(
      `<h1>FlowCode semantic capture fixture</h1>
<form id="order-form">
  <label>Customer name <input id="customer-name" name="customer_name" placeholder="Customer name"></label>
  <label>Password <input id="password" name="password" type="password" autocomplete="current-password"></label>
  <label>Card number <input id="card-number" name="payment_card_number" autocomplete="cc-number"></label>
  <label>Region <select id="region"><option value="north">North</option><option value="south">South</option></select></label>
  <label><input id="confirm" type="checkbox"> Confirm order</label>
  <label>Attachment <input id="attachment" type="file"></label>
  <button id="submit-order" data-testid="submit-order" type="submit">Submit order</button>
</form>
<p id="result" role="status"></p>
<div class="actions">
  <button id="spa" type="button">SPA navigation</button>
  <button id="popup" type="button">Open popup</button>
  <a id="download" href="/download" download>Download fixture</a>
</div>
<div id="shadow-host"></div>
<iframe title="Same-origin frame" src="/same-frame"></iframe>
<iframe title="Cross-origin frame" src="http://127.0.0.1:${secondaryPort}/cross-frame"></iframe>`,
      `document.querySelector('#order-form').addEventListener('submit', event => { event.preventDefault(); document.querySelector('#result').textContent = 'Order captured'; });
document.querySelector('#spa').addEventListener('click', () => history.pushState({}, '', '/orders/42?token=must-not-persist#private'));
document.querySelector('#popup').addEventListener('click', () => window.open('/popup', 'flowcode-popup', 'width=420,height=320'));
const shadow = document.querySelector('#shadow-host').attachShadow({ mode: 'open' });
shadow.innerHTML = '<label>Shadow value <input id="shadow-input"></label><button id="shadow-button" type="button">Shadow action</button>';`,
    ),
  );
});

const secondary = http.createServer((request, response) => {
  response.writeHead(200, { "content-type": "text/html; charset=utf-8" });
  response.end(
    html("<label>Cross-origin frame <input id='cross-frame-input'></label>"),
  );
});

secondaryPort = await listen(secondary);
const primaryPort = await listen(primary);
process.stdout.write(`${JSON.stringify({ primaryPort, secondaryPort })}\n`);

const close = () => {
  primary.close();
  secondary.close();
};
process.on("SIGINT", close);
process.on("SIGTERM", close);

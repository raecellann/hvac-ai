(function () {
  "use strict";

  var ICONS = {
    copy: '<svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="9" y="9" width="11" height="11" rx="2"/><path d="M5 15V5a2 2 0 0 1 2-2h10"/></svg>',
    up: '<svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M7 10v11H4V10h3zm0 0 4-7a2 2 0 0 1 2 2v4h5.5a2 2 0 0 1 2 2.3l-1.4 8A2 2 0 0 1 17.1 21H7"/></svg>',
    down: '<svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M17 14V3h3v11h-3zm0 0-4 7a2 2 0 0 1-2-2v-4H5.5a2 2 0 0 1-2-2.3l1.4-8A2 2 0 0 1 6.9 3H17"/></svg>',
    think: '<svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="9"/><path d="M12 7v5l3 2"/></svg>',
    search: '<svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="11" cy="11" r="7"/><path d="m20 20-3.5-3.5"/></svg>',
    chevron: '<svg class="hvac-ai__chev" viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="m9 6 6 6-6 6"/></svg>',
    wrench: '<svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M14.7 6.3a1 1 0 0 0 0 1.4l1.6 1.6a1 1 0 0 0 1.4 0l3.77-3.77a6 6 0 0 1-7.94 7.94l-6.91 6.91a2.12 2.12 0 0 1-3-3l6.91-6.91a6 6 0 0 1 7.94-7.94l-3.76 3.76z"/></svg>'
  };

  function escapeHtml(s) {
    return String(s)
      .replace(/&/g, "&amp;")
      .replace(/</g, "&lt;")
      .replace(/>/g, "&gt;")
      .replace(/"/g, "&quot;")
      .replace(/'/g, "&#39;");
  }

  /** Inline formatting: **bold** and [[value chips]]. Input is already escaped. */
  function inline(s) {
    return s
      .replace(/\[\[([^\]\n]{1,40})\]\]/g, '<span class="hvac-ai__chip">$1</span>')
      .replace(/\*\*([^*\n]+)\*\*/g, "<strong>$1</strong>");
  }

  /** Minimal, safe markdown: paragraphs, bullet lists, bold, chips. */
  function render(text) {
    var blocks = escapeHtml(text).split(/\n{2,}/);
    return blocks
      .map(function (block) {
        var lines = block.split("\n");
        var isList = lines.every(function (l) { return /^\s*([-*•]|\d+[.)])\s+/.test(l); });
        if (isList) {
          var ordered = /^\s*\d/.test(lines[0]);
          var items = lines
            .map(function (l) { return "<li>" + inline(l.replace(/^\s*([-*•]|\d+[.)])\s+/, "")) + "</li>"; })
            .join("");
          return ordered ? "<ol>" + items + "</ol>" : "<ul>" + items + "</ul>";
        }
        return "<p>" + inline(lines.join("<br>")) + "</p>";
      })
      .join("");
  }

  function formatMoney(amount, currency) {
    try {
      return new Intl.NumberFormat(undefined, { style: "currency", currency: currency || "USD" }).format(Number(amount));
    } catch (e) {
      return "$" + Number(amount).toFixed(2);
    }
  }

  function partCard(p) {
    var a = document.createElement("a");
    a.className = "hvac-ai__part";
    a.href = p.url;
    var img = p.image
      ? '<img src="' + escapeHtml(p.image) + '" alt="" loading="lazy" width="56" height="56">'
      : '<span class="hvac-ai__part-ph">' + ICONS.wrench + "</span>";
    a.innerHTML =
      img +
      '<span class="hvac-ai__part-body">' +
      '<span class="hvac-ai__part-title">' + escapeHtml(p.title) + "</span>" +
      '<span class="hvac-ai__part-meta">' +
      (p.price ? '<b>' + escapeHtml(formatMoney(p.price, p.currency)) + "</b>" : "") +
      (p.compareAtPrice ? ' <s>' + escapeHtml(formatMoney(p.compareAtPrice, p.currency)) + "</s>" : "") +
      ' <span class="hvac-ai__stock ' + (p.available ? "is-in" : "is-out") + '">' +
      (p.available ? "In stock" : "Currently unavailable") + "</span>" +
      "</span></span>" +
      '<span class="hvac-ai__part-cta">View part</span>';
    return a;
  }

  function Assistant(root) {
    this.root = root;
    this.endpoint = root.dataset.endpoint;
    this.productHandle = root.dataset.productHandle || null;
    this.collectionTitle = root.dataset.collectionTitle || null;
    this.log = root.querySelector(".hvac-ai__log");
    this.form = root.querySelector(".hvac-ai__form");
    this.input = root.querySelector(".hvac-ai__input");
    this.send = root.querySelector(".hvac-ai__send");
    this.suggestions = root.querySelector(".hvac-ai__suggestions");
    this.history = [];
    this.busy = false;
    this.storeKey = "hvac-ai:" + (this.productHandle || "collection");
    this.restore();
    this.bind();
  }

  Assistant.prototype.bind = function () {
    var self = this;
    this.form.addEventListener("submit", function (e) {
      e.preventDefault();
      self.ask(self.input.value);
    });
    this.input.addEventListener("keydown", function (e) {
      if (e.key === "Enter" && !e.shiftKey) {
        e.preventDefault();
        self.ask(self.input.value);
      }
    });
    this.input.addEventListener("input", function () {
      self.input.style.height = "auto";
      self.input.style.height = Math.min(self.input.scrollHeight, 160) + "px";
    });
    this.suggestions.addEventListener("click", function (e) {
      var btn = e.target.closest(".hvac-ai__suggestion");
      if (btn) self.ask(btn.textContent);
    });
  };

  Assistant.prototype.save = function () {
    try {
      sessionStorage.setItem(this.storeKey, JSON.stringify(this.history.slice(-12)));
    } catch (e) { /* storage unavailable */ }
  };

  Assistant.prototype.restore = function () {
    var saved;
    try { saved = JSON.parse(sessionStorage.getItem(this.storeKey) || "[]"); } catch (e) { saved = []; }
    if (!Array.isArray(saved) || !saved.length) return;
    var self = this;
    saved.forEach(function (m) {
      if (m.role === "user") self.addUser(m.content);
      else self.addAssistant({ reply: m.content, steps: m.steps || [], parts: m.parts || [] }, true);
    });
    this.history = saved;
    this.root.classList.add("has-messages");
  };

  Assistant.prototype.scroll = function () {
    this.log.scrollTop = this.log.scrollHeight;
  };

  Assistant.prototype.addUser = function (text) {
    var el = document.createElement("div");
    el.className = "hvac-ai__msg hvac-ai__msg--user";
    el.textContent = text;
    this.log.appendChild(el);
    this.scroll();
  };

  Assistant.prototype.addPending = function () {
    var el = document.createElement("div");
    el.className = "hvac-ai__msg hvac-ai__msg--bot is-pending";
    el.innerHTML =
      '<div class="hvac-ai__status">' + ICONS.think + ' <span>Thinking through the diagnosis</span><span class="hvac-ai__dots"><i></i><i></i><i></i></span></div>';
    this.log.appendChild(el);
    this.scroll();
    return el;
  };

  Assistant.prototype.addAssistant = function (data, restored, el) {
    el = el || document.createElement("div");
    el.className = "hvac-ai__msg hvac-ai__msg--bot";
    var steps = data.steps || [];
    var stepsHtml =
      '<details class="hvac-ai__trace"><summary>' + ICONS.think + " Finished thinking " + ICONS.chevron + "</summary>" +
      '<p class="hvac-ai__trace-body">Checked the symptom against the furnace/AC sequence of operation and isolated the likely failure points.</p></details>';
    if (steps.length) {
      stepsHtml +=
        '<details class="hvac-ai__trace"><summary>' + ICONS.search + " Found troubleshooting solutions " + ICONS.chevron + "</summary><ul class=\"hvac-ai__trace-body\">" +
        steps.map(function (s) { return "<li>" + escapeHtml(s.label) + "</li>"; }).join("") +
        "</ul></details>";
    }
    el.innerHTML =
      stepsHtml +
      '<div class="hvac-ai__name"><span class="hvac-ai__avatar hvac-ai__avatar--sm">' + ICONS.wrench + "</span> HVAC AI</div>" +
      '<div class="hvac-ai__text">' + render(data.reply) + "</div>";

    if (data.parts && data.parts.length) {
      var list = document.createElement("div");
      list.className = "hvac-ai__parts";
      data.parts.forEach(function (p) { list.appendChild(partCard(p)); });
      el.appendChild(list);
    }

    var actions = document.createElement("div");
    actions.className = "hvac-ai__actions";
    actions.innerHTML =
      '<button type="button" data-act="copy" aria-label="Copy answer">' + ICONS.copy + "</button>" +
      '<button type="button" data-act="up" aria-label="Helpful">' + ICONS.up + "</button>" +
      '<button type="button" data-act="down" aria-label="Not helpful">' + ICONS.down + "</button>";
    actions.addEventListener("click", function (e) {
      var b = e.target.closest("button");
      if (!b) return;
      if (b.dataset.act === "copy" && navigator.clipboard) {
        navigator.clipboard.writeText(data.reply.replace(/\[\[|\]\]|\*\*/g, ""));
      }
      actions.querySelectorAll("button").forEach(function (x) { x.classList.remove("is-active"); });
      b.classList.add("is-active");
    });
    el.appendChild(actions);

    if (!el.parentNode) this.log.appendChild(el);
    if (!restored) this.scroll();
  };

  Assistant.prototype.ask = function (raw) {
    var text = String(raw || "").trim();
    if (!text || this.busy) return;
    this.busy = true;
    this.root.classList.add("has-messages", "is-busy");
    this.send.disabled = true;
    this.input.value = "";
    this.input.style.height = "auto";

    this.addUser(text);
    this.history.push({ role: "user", content: text });
    var pending = this.addPending();
    var self = this;

    fetch(this.endpoint, {
      method: "POST",
      headers: { "Content-Type": "application/json", Accept: "application/json" },
      credentials: "same-origin",
      body: JSON.stringify({
        messages: this.history.map(function (m) { return { role: m.role, content: m.content }; }),
        productHandle: this.productHandle,
        collectionTitle: this.collectionTitle
      })
    })
      .then(function (res) {
        return res.json().catch(function () { return {}; }).then(function (data) {
          if (!res.ok || data.error) throw new Error(data.error || "Request failed (" + res.status + ")");
          return data;
        });
      })
      .then(function (data) {
        self.addAssistant(data, false, pending);
        self.history.push({ role: "assistant", content: data.reply, steps: data.steps, parts: data.parts });
        self.save();
      })
      .catch(function (err) {
        self.history.pop();
        pending.className = "hvac-ai__msg hvac-ai__msg--bot is-error";
        pending.textContent = err.message || "Something went wrong. Please try again.";
      })
      .finally(function () {
        self.busy = false;
        self.root.classList.remove("is-busy");
        self.send.disabled = false;
        self.input.focus();
      });
  };

  function init() {
    document.querySelectorAll(".hvac-ai:not([data-ready])").forEach(function (root) {
      root.setAttribute("data-ready", "");
      new Assistant(root);
    });
  }

  if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", init);
  else init();
  document.addEventListener("shopify:section:load", init);

  window.HvacAI = { render: render };
})();

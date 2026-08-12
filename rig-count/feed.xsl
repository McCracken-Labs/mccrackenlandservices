<?xml version="1.0" encoding="UTF-8"?>
<xsl:stylesheet version="1.0"
  xmlns:xsl="http://www.w3.org/1999/XSL/Transform"
  xmlns:atom="http://www.w3.org/2005/Atom">
  <xsl:output method="html" encoding="UTF-8" indent="yes"
    doctype-system="about:legacy-compat"/>

  <xsl:template match="/rss/channel">
    <html lang="en">
    <head>
      <meta charset="utf-8"/>
      <meta name="viewport" content="width=device-width, initial-scale=1"/>
      <title><xsl:value-of select="title"/> (RSS feed)</title>
      <link rel="preconnect" href="https://fonts.googleapis.com"/>
      <link href="https://fonts.googleapis.com/css2?family=Inter:wght@400;500;600;700&amp;family=Source+Serif+4:opsz,wght@8..60,600;8..60,700&amp;display=swap" rel="stylesheet"/>
      <style>
        :root{--navy:#0f2a3f;--navy2:#163b56;--gold:#c79a3b;--gold2:#d8b256;--sand:#f7f4ee;--ink:#14202b;--ink2:#33454f;--ink3:#5d6b73;--line:#dfd8cc}
        *{box-sizing:border-box}
        body{margin:0;background:var(--sand);color:var(--ink);font-family:"Inter",-apple-system,Segoe UI,Roboto,Arial,sans-serif;line-height:1.55;-webkit-font-smoothing:antialiased}
        .wrap{max-width:760px;margin:0 auto;padding:0 20px 60px}
        .masthead{background:var(--navy);color:#fff;margin:0 -20px 0;padding:30px 26px 26px;border-radius:0 0 12px 12px}
        .eyebrow{font-size:11px;letter-spacing:.16em;font-weight:700;color:var(--gold2);text-transform:uppercase;margin-bottom:8px}
        .masthead h1{font-family:"Source Serif 4",Georgia,serif;font-weight:700;font-size:26px;line-height:1.15;margin:0 0 8px}
        .tag{margin:0;color:rgba(255,255,255,.85);font-size:14px}
        .callout{background:#fff;border:1px solid var(--line);border-left:4px solid var(--gold);border-radius:10px;padding:16px 18px;margin:22px 0}
        .callout p{margin:0;font-size:15px;color:var(--ink2)}
        .callout strong{color:var(--ink)}
        h2{font-family:"Source Serif 4",Georgia,serif;font-size:19px;color:var(--navy);border-bottom:2px solid var(--gold);padding-bottom:5px;margin:34px 0 14px}
        ol{margin:0;padding-left:20px}
        ol li{margin:0 0 12px;font-size:15px;color:var(--ink2)}
        .url{margin:8px 0 2px;background:var(--navy);color:#fff;font-family:ui-monospace,SFMono-Regular,Menlo,Consolas,monospace;font-size:13px;padding:10px 12px;border-radius:8px;word-break:break-all;-webkit-user-select:all;user-select:all}
        .readers{margin:6px 0 0;font-size:13.5px;color:var(--ink3)}
        .item{background:#fff;border:1px solid var(--line);border-radius:10px;padding:16px 18px;margin:0 0 14px}
        .item h3{margin:0 0 4px;font-size:17px;font-family:"Source Serif 4",Georgia,serif}
        .item h3 a{color:var(--navy);text-decoration:none}
        .item h3 a:hover{text-decoration:underline}
        .date{font-size:12.5px;color:var(--ink3);margin:0 0 8px}
        .item p{margin:0 0 8px;font-size:14.5px;color:var(--ink2)}
        .pdf{display:inline-block;font-size:13px;font-weight:600;color:var(--navy);text-decoration:none;border:1px solid var(--line);border-radius:7px;padding:6px 12px;background:var(--sand)}
        .pdf:hover{border-color:var(--gold)}
        .foot{margin-top:34px;padding-top:16px;border-top:1px solid var(--line);display:flex;flex-wrap:wrap;gap:8px;justify-content:space-between;font-size:13px;color:var(--ink3)}
        .foot a{color:var(--navy);text-decoration:none;font-weight:600}
        @media (max-width:520px){.masthead h1{font-size:22px}}
      </style>
    </head>
    <body>
      <div class="wrap">
        <div class="masthead">
          <div class="eyebrow">RSS Feed</div>
          <h1><xsl:value-of select="title"/></h1>
          <p class="tag"><xsl:value-of select="description"/></p>
        </div>

        <div class="callout">
          <p><strong>You are looking at an RSS feed.</strong> In a browser it usually shows up as plain code, which is normal. RSS is a simple, free way to follow this page without email and without remembering to check back. When a new update posts, it appears on its own in whatever app you use to read feeds.</p>
        </div>

        <h2>How to subscribe</h2>
        <ol>
          <li>Copy this feed's web address:
            <div class="url"><xsl:value-of select="atom:link/@href"/></div>
          </li>
          <li>Open a news reader, sometimes called an RSS reader. Free ones include Feedly and Inoreader in a browser, NetNewsWire on Apple devices, Feeder on Android, and Thunderbird on a computer.
            <div class="readers">Many web browsers also have a free feed-reader add-on if you prefer that.</div>
          </li>
          <li>In the reader, choose Add feed or Follow, and paste the address. New posts then arrive on their own, with no account or email needed here.</li>
        </ol>

        <h2>Latest updates</h2>
        <xsl:for-each select="item">
          <div class="item">
            <h3><a href="{link}"><xsl:value-of select="title"/></a></h3>
            <div class="date"><xsl:value-of select="pubDate"/></div>
            <p><xsl:value-of select="description"/></p>
            <xsl:if test="enclosure/@url">
              <p><a class="pdf" href="{enclosure/@url}">Download the PDF</a></p>
            </xsl:if>
          </div>
        </xsl:for-each>

        <div class="foot">
          <a href="{link}">Back to the page</a>
          <span>McCracken Land Services, mccrackenlandservices.com</span>
        </div>
      </div>
    </body>
    </html>
  </xsl:template>
</xsl:stylesheet>

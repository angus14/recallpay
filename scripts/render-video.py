#!/usr/bin/env python3
"""Render a captioned replay from results/demo.json; requires Pillow and FFmpeg."""
import json
import subprocess
import tempfile
from pathlib import Path

from PIL import Image, ImageDraw, ImageFont

ROOT = Path(__file__).resolve().parent.parent
DATA = json.loads((ROOT / "results/demo.json").read_text())
assert DATA["status"] == "passed"
assert len(DATA["checks"]) == 16 and all(c["passed"] for c in DATA["checks"])
TX = {t["label"]: t for t in DATA["transactions"]}
W, H = 1280, 720
BG, WHITE, MINT, MUTED, DARK = "#0b1c1b", "#f6faf6", "#6fe2ad", "#a9c4b8", "#16332e"
FONT_DIR = Path("/usr/share/fonts/truetype/dejavu")
def font(size, bold=False):
    return ImageFont.truetype(str(FONT_DIR / ("DejaVuSans-Bold.ttf" if bold else "DejaVuSans.ttf")), size)

def scene(number, eyebrow, title, lines, accent, hash_label=None):
    im = Image.new("RGB", (W,H), BG)
    d = ImageDraw.Draw(im)
    d.rounded_rectangle((62,53,1218,667), radius=28, fill=DARK)
    d.rectangle((62,53,1218,62), fill=MINT)
    d.text((100,100), "RECALLPAY  /  LOCAL NEAR SANDBOX REPLAY", font=font(20,True), fill=MINT)
    d.text((100,169), eyebrow.upper(), font=font(24,True), fill=MUTED)
    d.text((100,224), title, font=font(46,True), fill=WHITE)
    y=330
    for line in lines:
        d.ellipse((102,y+12,116,y+26), fill=MINT)
        d.text((138,y), line, font=font(26), fill=WHITE)
        y+=62
    if hash_label:
        t=TX[hash_label]
        d.text((100,578), "Sandbox transaction  "+t["hash"][:16]+"…", font=font(19), fill=MUTED)
    d.text((100,628), accent, font=font(20,True), fill=MINT)
    d.text((1125,628), f"{number:02d} / 07", font=font(18), fill=MUTED)
    return im

frames = [
 scene(1,"The problem","Data changes after agents buy it",
       ["A warehouse says stock is 80.", "Two agents buy that inventory version.", "A later correction says the stock is 8."],
       "What happens to jobs that used the bad version?"),
 scene(2,"Before the sale","Refunds are funded in advance",
       ["Provider locks 1 NEAR in a separate reserve.", "Two buyers purchase inventory and shipping data.", "Each protected purchase locks its refund coverage."],
       "Purchase fees do not fund their own refunds.",
       "Provider funds 1 NEAR refund reserve"),
 scene(3,"The economic check","Seller withdraws earned fees",
       ["The provider receives 0.6 NEAR in sale proceeds.", "It withdraws those proceeds before the recall.", "The separate reserve still backs buyer refunds."],
       "This is a real sandbox transfer, not an accounting label.",
       "Provider withdraws earned 0.6 NEAR before the recall"),
 scene(4,"The recall","The exact inventory version is revoked",
       ["Provider records the correction: 80 becomes 8.", "Three dependent jobs pause, including a derived job.", "Two independent shipping jobs remain ready."],
       "The agent dependency graph determines the affected jobs.",
       "Provider recalls inventory: stock was 8, not 80"),
 scene(5,"Enforcement","A stale payment is rejected",
       ["One client missed the recall notification.", "Its attempted payment is blocked on NEAR.", "Independent jobs still complete their paid action."],
       "The gate applies at payment time.",
       "Stale client tries to pay using recalled inventory"),
 scene(6,"Refund","Buyers receive native NEAR",
       ["A keeper claims for the fixed beneficiaries.", "Alice and Bob each withdraw 0.2 NEAR.", "A second claim is rejected."],
       "0.4 NEAR reached separate buyer wallets.",
       "bob withdraws refund as real NEAR"),
 scene(7,"Verified outcome","One correction, a funded response",
       ["19 integration subtests passed on local NEAR.", "16/16 demo checks passed across 17 transactions.", "3 jobs paused; 2 continued; 0.4 NEAR refunded."],
       "Scripted agents and synthetic data; no mainnet deployment."),
]
with tempfile.TemporaryDirectory() as tmp:
    directory=Path(tmp)
    for i, im in enumerate(frames): im.save(directory/f"frame_{i:02d}.png")
    subprocess.run(["ffmpeg","-hide_banner","-loglevel","error","-y","-framerate","1/6",
                    "-i",str(directory/"frame_%02d.png"),"-vf","fps=25",
                    "-c:v","libx264","-pix_fmt","yuv420p","-movflags","+faststart",
                    str(ROOT/"RecallPay_demo.mp4")],check=True)
print(ROOT/"RecallPay_demo.mp4")

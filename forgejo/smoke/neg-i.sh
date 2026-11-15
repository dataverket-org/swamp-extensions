#!/usr/bin/env bash
source "$(dirname "$0")/negative.sh"
echo "=== I. wiki pages ==="
# A title with both dashes and spaces: Forgejo stores it escaped, with a `.-`
# suffix, and its page endpoints take that path and not the title.
T='design notes v-2'
N='wiki-fxorg-tool-design-notes-v-2'
W=${REPO:-.}/.wiki-smoke
mkdir -p "$W"
printf '# Design notes\n\nKunnskap, åpen kildekode, suverenitet.\n' > "$W/v1.md"
printf '# Design notes\n\nRevidert: åpen kildekode, fortsatt.\n' > "$W/v2.md"
# The page an earlier run left, removed, so the batch can run again.
forge DELETE "/repos/fxorg/tool/wiki/page/design+notes+v-2.-" >/dev/null 2>&1 || true
sha() { shasum -a 256 "$1" | cut -c1-64; }
revisions() { forge GET "/repos/fxorg/tool/wiki/revisions/$1" | jq -r '.count // 0'; }

refuses "wiki_page_get names a page the wiki does not have" "no wiki page titled" \
  forge wiki_page_get owner=fxorg name=tool "page=$T"
holds "wiki_page_ensure creates a missing page with the default message, content not recorded" \
  ".dataArtifacts[] | select(.name == \"$N\") | .attributes | .action == \"created\" and .previousSha256 == null and .message == \"Add $T\" and .content == null and .contentSha256 == \"$(sha "$W/v1.md")\"" \
  forge wiki_page_ensure owner=fxorg name=tool "page=$T" "content=@$W/v1.md"
SUB=$(artifact "$N" | jq -r .subUrl)
if [ "$(code "/repos/fxorg/tool/wiki/page/$SUB")" = 200 ] && [ "$(code "/repos/fxorg/tool/wiki/page/design-notes-v-2")" = 404 ]; then
  ok "... the record carries the escaped path the forge serves the page at ($SUB); the title as a path is a 404"
else
  bad "... the escaped path" "sub_url=$SUB served $(code "/repos/fxorg/tool/wiki/page/$SUB"), title path $(code "/repos/fxorg/tool/wiki/page/design-notes-v-2")"
fi
R1=$(revisions "$SUB")
holds "... a second run with the same content is unchanged" \
  ".dataArtifacts[] | select(.name == \"$N\") | .attributes | .action == \"unchanged\" and .message == null and .previousSha256 == .contentSha256" \
  forge wiki_page_ensure owner=fxorg name=tool "page=$T" "content=@$W/v1.md"
if [ "$(revisions "$SUB")" = "$R1" ]; then ok "... and made no wiki commit"; else bad "... no wiki commit" "revisions $R1 -> $(revisions "$SUB")"; fi
holds "... new content is an update, with the message given and the hash of what was there" \
  ".dataArtifacts[] | select(.name == \"$N\") | .attributes | .action == \"updated\" and .message == \"Rework after review\" and .previousSha256 == \"$(sha "$W/v1.md")\" and .contentSha256 == \"$(sha "$W/v2.md")\"" \
  forge wiki_page_ensure owner=fxorg name=tool "page=$T" "content=@$W/v2.md" "message=Rework after review"
if [ "$(revisions "$SUB")" = "$((R1 + 1))" ]; then ok "... as one wiki commit"; else bad "... one wiki commit" "revisions $R1 -> $(revisions "$SUB")"; fi
holds "wiki_page_get reads the page back: content, hash and the last commit's message" \
  ".dataArtifacts[] | select(.name == \"$N\") | .attributes | .action == \"observed\" and .contentSha256 == \"$(sha "$W/v2.md")\" and .lastCommit.message == \"Rework after review\n\" and .subUrl == \"$SUB\"" \
  forge wiki_page_get owner=fxorg name=tool "page=$T"
if [ "$(artifact "$N" | jq -r .content)" = "$(cat "$W/v2.md")" ]; then
  ok "... byte for byte, letters outside ASCII included"
else
  bad "... byte for byte" "$(artifact "$N" | jq -c .content | head -c 200)"
fi
holds "a title matched ignoring case reads the same page, recorded under the forge's title" \
  ".dataArtifacts[] | select(.name == \"$N\") | .attributes | .action == \"observed\" and .title == \"$T\"" \
  forge wiki_page_get owner=fxorg name=tool "page=Design Notes V-2"
holds "a token with read:repository reads a page" \
  ".dataArtifacts[] | select(.name == \"$N\") | .attributes.action == \"observed\"" \
  forge-narrow wiki_page_get owner=fxorg name=tool "page=$T"
refuses "... and its write is refused with the forge's message, before anything changes" "HTTP 403.*scope" \
  forge-narrow wiki_page_ensure owner=fxorg name=tool "page=$T" "content=@$W/v1.md"
if [ "$(revisions "$SUB")" = "$((R1 + 1))" ]; then ok "... nothing was written"; else bad "... nothing written" "revisions moved"; fi
# fxorg/nopr with its wiki unit off, for this check only; batch e removed fxnew.
forge PATCH /repos/fxorg/nopr '{"has_wiki":false}' >/dev/null
refuses "a repository whose wiki is off is named before anything is written" "wiki of fxorg/nopr is off" \
  forge wiki_page_ensure owner=fxorg name=nopr page=Home "content=@$W/v1.md"
refuses "... and so is a read of it" "wiki of fxorg/nopr is off" \
  forge wiki_page_get owner=fxorg name=nopr page=Home
forge PATCH /repos/fxorg/nopr '{"has_wiki":true}' >/dev/null
refuses "a repository that is not there is reported as what it is" "HTTP 404" \
  forge wiki_page_get owner=fxorg name=nothere page=Home
refuses "a closed port is reported, not retried" "ECONNREFUSED|refused|unreachable|connect" \
  forge-closed wiki_page_get owner=fxorg name=tool "page=$T"
summary

# BVNxVH 3.8.6 — chơi hai người qua link

## Gói trọn bộ

- Windows x64: `build/BVNxVH386-Windows-Online.zip`
- Mac Apple Silicon: `build/BVNxVH386-Mac-AppleSilicon-Online.zip`
- Ubuntu/Linux: `build/BVNxVH386-Ubuntu-Linux.zip` (launcher cho chế độ chơi trong trình duyệt)

Mỗi ZIP là một lượt tải, gồm game, cầu nối và Node.js 22.23.4 đúng hệ điều hành. Người chơi không cần cài Node.js riêng. Sau khi giải nén, mở `Start-Online.cmd` (Windows) hoặc `Start-Online.command` (Mac), dán mã kết nối lấy từ trang phòng và để cửa sổ đó chạy.

Gói Windows chứa `BVNxVH386-Windows.air`; máy Windows vẫn cần Adobe AIR runtime để cài tệp `.air`. Gói Mac có sẵn AIR runtime trong ứng dụng, chỉ dành cho Apple Silicon và chưa được Apple notarize. Xem `README-INSTALL.txt` bên trong mỗi gói.

## Chọn cách chơi

**Game AIR trên từng máy · P2P trực tiếp** là lựa chọn mặc định. P1 và P2 mở game AIR của mình và chạy `Start-Online`. WebRTC DataChannel mang các luồng TCP/UDP trực tiếp giữa hai máy. Máy chủ chỉ ghép phòng và chuyển tín hiệu ICE/SDP; server từ chối khung dữ liệu nhị phân từ agent. Nếu NAT của một người chơi chặn kết nối trực tiếp, cần cấu hình TURN server trên máy chủ riêng.

**P2P trong trình duyệt** hiện là thử nghiệm, chạy `launch-web-online.swf` qua Ruffle và gửi phím trực tiếp qua WebRTC. Ruffle chưa hỗ trợ đầy đủ API `File` của AIR mà game dùng để đọc file ngôn ngữ; hiện game có thể hiện màn hình đen. Để chơi thật, dùng gói game AIR Windows/Mac ở chế độ P2P trực tiếp.

Ubuntu/Linux: `BVNxVH386-Ubuntu-Linux.zip` chỉ mở link mời trong Firefox/Chromium; không cài Node.js. Bản game AIR hiện chưa chạy ổn trong Ruffle trên trình duyệt. Gói Linux chưa phải game client chơi được.

## Chạy máy chủ và Quick Tunnel

Máy chủ cần có thư mục game để phục vụ các tệp cho chế độ trình duyệt:

```bash
npm ci
PORT=3001 npm start -- "$GAME"
npx wrangler@latest tunnel quick-start http://127.0.0.1:3001
```

`$GAME` cần trỏ tới thư mục `死神vs火影_竞技版 3.8.6`. Quick Tunnel chỉ hoạt động khi cả máy chủ và tunnel còn chạy. Để chạy khi máy tạo link tắt, cần đặt signaling server và tệp tĩnh trên máy chủ public; TURN cũng cần một dịch vụ riêng nếu hai người không kết nối P2P trực tiếp được.

## Tạo lại các gói

Lấy hai archive chính thức Node.js v22.23.4 (`win-x64.zip` và `darwin-arm64.tar.gz`), đặt ở `/private/tmp` hoặc truyền đường dẫn qua `NODE_WIN_ZIP` và `NODE_MAC_TAR`, rồi chạy:

```bash
node scripts/build-player-bundles.mjs
```

Script kiểm tra SHA-256 của archive Node.js trước khi tạo ZIP.

## Tình trạng kiểm chứng

Hai agent kết nối qua tunnel công khai, bắt tay WebRTC trực tiếp, rồi chuyển tiếp echo TCP và UDP qua DataChannel; signaling WebSocket chỉ chuyển offer/answer. Hai ZIP hiện tại qua kiểm tra cấu trúc và chứa `werift` cùng agent P2P. Chưa có bằng chứng một trận BVN hoàn chỉnh giữa hai máy.

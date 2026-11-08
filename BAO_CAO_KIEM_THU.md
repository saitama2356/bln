# Báo cáo cập nhật và kiểm thử Bleach vs Naruto 3.0

## Hiện trạng và nguyên nhân đã xác minh

Bản đầu vào là `Bleach_vs_Naruto_3_0_Render_Singapore_Toi_Uu.zip`. Ở bản này, P1 chạy Ruffle. P2 gửi phím và xem hình từ P1. Nếu WebRTC thất bại, JPEG dự phòng dùng chung WebSocket với tín hiệu điều khiển. Bản đầu vào đóng phòng ngay khi mất kết nối P1 và dùng DataChannel không bảo đảm thứ tự hoặc phát lại.

Hiện tượng được báo gồm đứng toàn bộ trận, đôi lúc nền đen và ngừng nhạc hoặc âm thanh, trong khi nút ngoài game vẫn dùng được. Sự cố cũng xảy ra khi đấu máy. Đây là lý do tách việc kiểm tra engine khỏi mạng. Chưa có tổ hợp nhân vật, bản đồ và phím tái hiện được hiện tượng này trong lần kiểm thử. Nguyên nhân trong ActionScript, renderer hoặc âm thanh vẫn chưa được xác định.

SWF gốc là phiên bản định dạng 17 và có cờ ActionScript 3. Gói giữ Ruffle `0.8.0-nightly.2026.10.26` (commit Ruffle `f6ee2b04825d7080c42c87990e9d594314a396bf`) từ bản setup ghim ở `222ba8f8f08b379509bde031a116108e1211c18a`. Kết quả setup có SWF, cây tài nguyên Việt hóa và bản Ruffle giống bản gốc theo đối chiếu tệp. SHA-256 của `public/game.swf` sau setup là `287427701a159d3dcf76c36a4546158be9b289cd8a2e0ffdb8ae077403bac37f`.

## Thay đổi

| Tệp | Phần đã cập nhật |
| --- | --- |
| `server.mjs` | Hai ghế với khóa kết nối lại, thời gian giữ ghế, phiên có số thứ tự, reset giữ mã, đăng ký worker bằng bí mật, phân quyền định tuyến ghế, WebSocket riêng cho JPEG. |
| `public/engine.js` | Khởi tạo và hủy Ruffle theo vòng đời. Nhận tín hiệu lỗi renderer, lỗi Ruffle nghiêm trọng và trạng thái phát. Lấy mẫu hình nhỏ khi có thao tác gần đây để cảnh báo nghi treo. |
| `public/media.js` | Kết nối hình riêng có tự kết nối lại, kiểm tra buffer, một tác vụ mã hóa JPEG mỗi lần, đổi chất lượng và tốc độ khi nghẽn. |
| `public/client.js`, `public/index.html`, `public/style.css` | Luồng kết nối và điều khiển theo ghế, giữ khung JPEG mới nhất khi giải mã bận, thông tin RTT/FPS, tải log, chọn chất lượng, khôi phục luồng và khởi động lại. |
| `public/worker.html`, `public/worker.js` | Một Ruffle chạy trên máy thứ ba, phát cho hai ghế, nhả phím khi ngắt, thử WebRTC theo từng ghế và lấy JPEG dự phòng từ cùng worker. |
| `.env.example`, `.gitignore`, `.dockerignore`, `README.md`, `tests/rooms.test.mjs` | Biến mẫu, loại tệp khóa cục bộ khỏi Git/build, hướng dẫn chạy và kiểm tra các ca giao thức quan trọng. |

Bản cập nhật phân biệt cảnh báo nghi game treo, lỗi renderer đã nhận, gián đoạn hình và mất kết nối phòng. Khởi động lại hủy game cũ và mở game từ menu. Nút **Kết nối lại hình** chỉ tạo lại đường truyền khi engine cũ còn chạy. Việc khôi phục hỗ trợ người chơi quay lại sau sự cố. Chưa có bản vá nguyên nhân gốc trong SWF.

## Môi trường và kết quả

Thử bằng Node.js 24 và Chromium headless 145 trên máy thử cục bộ. Hai ghế là hai ngữ cảnh trình duyệt. Chế độ worker dùng một ngữ cảnh riêng, truy cập cùng dịch vụ HTTP. Không dùng hạ tầng phát sinh phí.

| Bài thử | Kết quả | Phạm vi |
| --- | --- | --- |
| Kiểm tra cú pháp, cài dependency, setup 293 tệp và chạy dịch vụ | Đạt | Dùng cache npm và bộ tài nguyên gốc đã có, kiểm tra toàn bộ mã SHA-256, lấy đúng commit Ruffle. |
| Đối chiếu SWF, assets Việt hóa và Ruffle | Đạt | Cây tài nguyên giống bản đầu vào sau setup. |
| Tạo phòng, ID 6 ký tự, hai ghế và từ chối người thứ ba | Đạt | Kiểm thử trình duyệt và giao thức. |
| Hai yêu cầu reset cùng phiên, bản tin cũ và khóa worker sai | Đạt | Kiểm thử giao thức. Reset tăng một phiên. Khung sai phiên và người ngoài phòng bị chặn. |
| Giả lập mất context dựng hình, khởi động lại giữ mã | Đạt | Kiểm thử cảnh báo và khôi phục bằng sự kiện mô phỏng. |
| Đấu máy, vào trận và thử chuỗi phím khi chưa có P2 | Đạt | Ichigo gặp Naruto, trợ thủ Kon và Gaara, bản đồ `xianshi`. Không có hình JPEG truyền qua máy chủ. |
| 1v1 chế độ P1, chọn đấu sĩ, trợ thủ, bản đồ, thử phím và vào trận | Đạt | Game Flash chạy thật và P2 nhận JPEG. |
| Tải lại tab P2, nối lại đúng ghế, reset từ P2 và rời phòng | Đạt | Kiểm thử với JPEG cục bộ. |
| Chế độ worker, chọn đấu sĩ và vào trận từ hai máy khách | Đạt | Cả hai ghế nhận JPEG từ cùng một Ruffle trên trang worker. Thử gửi các phím J/K/L/U/I/O. |
| Worker dừng, thông báo cho cả hai, thử lại và dọn khi đóng phòng | Đạt | Thử trên trình duyệt. |
| Kết nối video và DataChannel trực tiếp qua WebRTC | Chưa đạt trong môi trường thử | Chromium không cho thấy ICE candidate trong phép thăm dò cục bộ. Luồng đi tới JPEG. Đã thử chuyển tín hiệu candidate trên giao thức. |
| Hai máy ở hai mạng Internet, Render đang chạy và TURN thực tế | Chưa chạy | Không triển khai dịch vụ thật từ gói bàn giao. |
| Tái hiện lỗi đóng băng gốc và so sánh renderer hoặc bản Ruffle cho đúng ca đó | Chưa đạt | Chưa có ca tái hiện chính xác. |
| Kiểm tra toàn bộ dạng biến hình, triệu hồi, âm thanh, combo và chơi dài | Chưa chạy | Các lượt thử hiện chỉ bao phủ một số phím, đấu sĩ và bản đồ. |

## Đo JPEG trước và sau

Đếm ảnh nhị phân P2 nhận qua WebSocket trong hai cửa sổ đo 8 giây, ở màn hình menu và cùng môi trường headless. FPS này đo số ảnh truyền tới trình duyệt. Thời gian tác vụ renderer lấy từ Chromium DevTools. Heap JS không gồm toàn bộ bộ nhớ WASM hoặc RAM của tiến trình.

| Mẫu | Khung nhận | FPS nhận | Kích thước | Tải hình | Tác vụ renderer P1 | Heap JS P1 |
| --- | ---: | ---: | --- | ---: | ---: | ---: |
| ZIP gốc, lượt 1 | 17 | 2,1 | 640 × 480 | 396 kbit/s | 945 ms/s | 5,7 MiB |
| ZIP sửa, lượt 1 | 7 | 0,9 | 640 × 480 | 262 kbit/s | 1.000 ms/s | 5,5 MiB |
| ZIP gốc, lượt 2 | 2 | 0,2 | 640 × 480 | 79 kbit/s | 997 ms/s | 5,0 MiB |
| ZIP sửa, lượt 2 | 22 | 2,7 | 640 × 480 | 792 kbit/s | 970 ms/s | 5,1 MiB |

Lượt 1 chạy đồng thời với một lượt kiểm thử trình duyệt khác, trước khi bộ lấy mẫu được giới hạn theo thao tác và chất lượng JPEG khởi điểm được đưa về mức của bản gốc. Lượt 2 thực hiện riêng với mã sửa cuối. Kết quả biến động mạnh khi Chromium headless gần bão hòa tác vụ renderer. Mẫu này chưa đủ để kết luận mức tăng FPS, mức tiết kiệm CPU, RAM hay độ trễ thực tế. Chưa có số đo FPS logic SWF, RAM toàn tiến trình, tải Render, hoặc độ trễ từ phím tới hình riêng cho P1 và P2.

Khi gặp lại ca đứng hình gốc, hãy lấy log từ cả hai ghế hoặc máy chạy engine, kèm nhân vật, bản đồ, combo và tình trạng âm thanh để khoanh vùng.

const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const cors = require('cors');

const app = express();
app.use(cors());
app.use(express.static('public'));
const server = http.createServer(app);
const io = new Server(server, {
    cors: {
        origin: "*", // Prodüksiyonda bunu frontend domaininiz ile değiştirin
        methods: ["GET", "POST"]
    }
});

// Sistemdeki aktif oyun odaları ve bekleyen oyuncular
const rooms = {};
let waitingPlayer = null;

// 38 Kartlık standart bir deste oluşturma (Mutasyonlar/çeşitlilik eklenebilir)
function createDeck() {
    const types = ['Agent', 'Gadget', 'Intel', 'Vehicle'];
    let deck = [];
    let idCounter = 1;
    
    // Her türden 9 kart = 36 kart
    types.forEach(type => {
        for (let i = 0; i < 9; i++) {
            deck.push({ id: idCounter++, type: type });
        }
    });
    // 2 Adet Joker/Özel Kart = 38 kart
    deck.push({ id: idCounter++, type: 'Wildcard' });
    deck.push({ id: idCounter++, type: 'Wildcard' });
    
    // Desteyi karıştır (Fisher-Yates algoritması)
    for (let i = deck.length - 1; i > 0; i--) {
        const j = Math.floor(Math.random() * (i + 1));
        [deck[i], deck[j]] = [deck[j], deck[i]];
    }
    return deck;
}

io.on('connection', (socket) => {
    console.log(`Yeni bağlantı tespit edildi: ${socket.id}`);

    // EŞLEŞTİRME SİSTEMİ
    socket.on('joinMatchmaking', () => {
        if (waitingPlayer && waitingPlayer !== socket) {
            // Eşleşme bulundu, oda oluşturuluyor
            const roomId = `room_${Date.now()}`;
            socket.join(roomId);
            waitingPlayer.join(roomId);

            const deck = createDeck();
            
            rooms[roomId] = {
                id: roomId,
                deck: deck,
                players: {
                    [waitingPlayer.id]: { id: waitingPlayer.id, hand: [], tableau: [], position: 0, number: 1 },
                    [socket.id]: { id: socket.id, hand: [], tableau: [], position: 10, number: 2 } // 20'lik pistte zıt kutupta
                },
                turn: waitingPlayer.id, // İlk bağlanan başlar
                currentOffer: null // { openCard: {}, hiddenCard: {} }
            };

            // Her oyuncuya 4 kart dağıt
            for (let i = 0; i < 4; i++) {
                rooms[roomId].players[waitingPlayer.id].hand.push(rooms[roomId].deck.pop());
                rooms[roomId].players[socket.id].hand.push(rooms[roomId].deck.pop());
            }

            io.to(roomId).emit('gameStart', rooms[roomId]);
            waitingPlayer = null;
        } else {
            // Bekleme havuzuna al
            waitingPlayer = socket;
            socket.emit('waitingForOpponent', { message: 'Rakip aranıyor...' });
        }
    });

    // 1. AŞAMA: AKTİF OYUNCUNUN KARTLARI SÜRMESİ
    socket.on('playOffer', ({ roomId, openCardId, hiddenCardId }) => {
        const room = rooms[roomId];
        if (!room || room.turn !== socket.id) return;

        const player = room.players[socket.id];
        
        // Kartları elden bul ve çıkar
        const openCardIndex = player.hand.findIndex(c => c.id === openCardId);
        const openCard = player.hand.splice(openCardIndex, 1)[0];
        
        const hiddenCardIndex = player.hand.findIndex(c => c.id === hiddenCardId);
        const hiddenCard = player.hand.splice(hiddenCardIndex, 1)[0];

        room.currentOffer = { openCard, hiddenCard, offeredBy: socket.id };

        // Rakibe sadece açık kartı ve kapalı kartın varlığını bildir
        socket.to(roomId).emit('offerReceived', {
            openCard: openCard,
            hiddenCard: { id: 'hidden', type: 'unknown' } 
        });
    });

    // 2. AŞAMA: RAKİBİN SEÇİM YAPMASI
    socket.on('selectOffer', ({ roomId, selectedIsHidden }) => {
        const room = rooms[roomId];
        if (!room || !room.currentOffer || room.turn === socket.id) return; // Sıra sahibi seçemez

        const activePlayerId = room.currentOffer.offeredBy;
        const opponentId = socket.id;
        
        let opponentCard, activePlayerCard;

        if (selectedIsHidden) {
            opponentCard = room.currentOffer.hiddenCard;
            activePlayerCard = room.currentOffer.openCard;
        } else {
            opponentCard = room.currentOffer.openCard;
            activePlayerCard = room.currentOffer.hiddenCard;
        }

        // Kartları oyuncuların önündeki set alanına (tableau) ekle
        room.players[opponentId].tableau.push(opponentCard);
        room.players[activePlayerId].tableau.push(activePlayerCard);

        // -- PİYON İLERLETME MANTIĞI --
        // Not: Burada set mekaniğine göre ilerletme fonksiyonunuzu yazabilirsiniz.
        // Şimdilik her alınan kart 1 birim ilerletir olarak modelledim.
        room.players[opponentId].position += 1;
        room.players[activePlayerId].position += 1;

        // Kart çekme (Eksilen kartları tamamla)
        if (room.deck.length >= 2) {
            room.players[activePlayerId].hand.push(room.deck.pop());
            room.players[activePlayerId].hand.push(room.deck.pop());
        }

        // Sırayı diğer oyuncuya geçir ve teklifi temizle
        room.turn = opponentId;
        room.currentOffer = null;

        // Kazanma Koşulu Kontrolü (Yakalamak veya geçmek)
        // 20 karelik dairesel piste göre mutlak mesafe farkı 10 veya üzerindeyse yakalamış demektir.
        const p1 = Object.values(room.players).find(p => p.number === 1);
        const p2 = Object.values(room.players).find(p => p.number === 2);
        
        // Başlangıçta P1 0'da, P2 10'da başlıyor.
        let winner = null;
        if (p1.position >= (p2.position - 10 + 20)) winner = p1.id; // P1 tur bindirdi/yakaladı
        if (p2.position >= (p1.position + 10)) winner = p2.id;      // P2 tur bindirdi/yakaladı

        if (winner) {
            io.to(roomId).emit('gameOver', { winnerId: winner, finalState: room });
            delete rooms[roomId]; // Bellek temizliği
        } else {
            // Yeni durumu odadaki herkese yayınla
            io.to(roomId).emit('updateState', room);
        }
    });

    // BAĞLANTI KOPMA YÖNETİMİ
    socket.on('disconnect', () => {
        if (waitingPlayer === socket) {
            waitingPlayer = null;
        }
        // Oyuncu koptuğunda içinde bulunduğu odayı bul ve kapat
        for (const roomId in rooms) {
            if (rooms[roomId].players[socket.id]) {
                socket.to(roomId).emit('opponentDisconnected', { message: 'Rakip oyundan ayrıldı.' });
                delete rooms[roomId];
                break;
            }
        }
    });
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
    console.log(`Prof. Dr. Gemini Sistem Kontrolü: Sunucu ${PORT} portunda aktif.`);
});
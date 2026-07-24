import { initializeApp } from "https://www.gstatic.com/firebasejs/11.6.1/firebase-app.js";
        import { getAuth, signInAnonymously, signInWithCustomToken } from "https://www.gstatic.com/firebasejs/11.6.1/firebase-auth.js";
        import { getFirestore, doc, getDoc, setDoc, onSnapshot, collection, getDocs } from "https://www.gstatic.com/firebasejs/11.6.1/firebase-firestore.js";
        import { PROJECT, cloneDefaultSchedule } from "./project-config.js";
        import { aggregateGroups, clamp, dateAt, diffDays, plannedRate, summarizeSchedule, taskDelayDays, validateSchedule } from "./schedule-engine.js";
        import { mergePhotoCollections, normalizePhoto } from "./photo-recovery.js";

        // Global Local Date String Helpers (Avoids UTC offset issues)
        function getLocalDateString(d = new Date()) {
            const year = d.getFullYear();
            const month = String(d.getMonth() + 1).padStart(2, '0');
            const day = String(d.getDate()).padStart(2, '0');
            return `${year}-${month}-${day}`;
        }

        function getYesterdayDateString() {
            const d = new Date();
            d.setDate(d.getDate() - 1);
            return getLocalDateString(d);
        }

        let activePhotoList = [];
        let activeSelectedIndex = 0;
        let archiveList = [];
        let sheetPhotoList = [];
        let registeredUsers = [];
        let currentUser = null;
        let authMode = 'login';
        let isAdminMode = false;
        let siteSettings = {
            siteName: "NH농협은행 강릉 금융센터 신축공사",
            sheetTitle: "사 진 대 장",
            defaultDesc: "현장 시공 및 품질 검측 확인 작업 시행"
        };

        let db, auth, appId;
        let unsubscribeUsers = null;
        let unsubscribeGlobalPhotos = null;
        let resolveGlobalPhotosReady;
        const globalPhotosReadyPromise = new Promise(resolve => { resolveGlobalPhotosReady = resolve; });
        let unsubscribeSettings = null;

        function showToast(msg) {
            const toast = document.getElementById('toastMessage');
            const toastText = document.getElementById('toastText');
            if (toast && toastText) {
                toastText.innerText = msg;
                toast.classList.remove('translate-y-20', 'opacity-0', 'pointer-events-none');
                setTimeout(() => {
                    toast.classList.add('translate-y-20', 'opacity-0', 'pointer-events-none');
                }, 3000);
            }
        }

        window.onload = async function() {
            const siteUrlLabelEl = document.getElementById('siteUrlLabel');
            if (siteUrlLabelEl) siteUrlLabelEl.innerText = window.location.host;
            const firebaseConfig = {
                apiKey: "AIzaSyBlq213t9H-XfbeJb5uMCWhAYX-tRFnlOA",
                authDomain: "gangneung-nh-photo.firebaseapp.com",
                projectId: "gangneung-nh-photo",
                storageBucket: "gangneung-nh-photo.firebasestorage.app",
                messagingSenderId: "212764985165",
                appId: "1:212764985165:web:0dd347561feabf91ab5904"
            };
            appId = 'gangneung-nh-default';

            try {
                const app = initializeApp(firebaseConfig);
                db = getFirestore(app);
                auth = getAuth(app);

                if (typeof __initial_auth_token !== 'undefined' && __initial_auth_token) {
                    await signInWithCustomToken(auth, __initial_auth_token);
                } else {
                    await signInAnonymously(auth);
                }
            } catch (e) {
                console.debug("Firebase init fallback", e);
            }

            setupGlobalUsersSync();
            setupGlobalSettingsSync();
            setupGlobalPublicPhotosSync();
            setupConstructionScheduleSync();
            renderMobileWorkTree();
            renderSiteSchedules();
            loadGangneungWeather();

            isAdminMode = false;
            updateAdminButtonState();

            // 로그인 정보는 브라우저 세션 동안만 유지한다.
            // 이전 버전에서 남긴 영구 로그인 정보는 자동 삭제한다.
            localStorage.removeItem('smart_construction_current_user');
            const savedUser = sessionStorage.getItem('smart_construction_current_user');
            if (savedUser) {
                try {
                    currentUser = JSON.parse(savedUser);
                    unlockApp(currentUser);
                } catch(e) {
                    lockApp();
                }
            } else {
                lockApp();
            }
        };

        async function setupGlobalPublicPhotosSync() {
            const rebuildViews = photos => {
                archiveList = mergePhotoCollections([photos || []]);
                sheetPhotoList = archiveList.filter(x => x.includeInSheet);
                localStorage.setItem('smart_construction_global_public_photos', JSON.stringify({ archive: archiveList }));
                updateDashboardCounts(); renderArchiveList(); renderPrintSheets();
                if (isAdminMode) renderAdminPhotoEditorList();
            };
            let localRecovered = [];
            const localPhotos = localStorage.getItem('smart_construction_global_public_photos');
            if (localPhotos) {
                try {
                    const parsed = JSON.parse(localPhotos), legacySheet = parsed.sheet || [];
                    const markedSheet = legacySheet.map((item, index) => normalizePhoto(item, true, index)).filter(Boolean);
                    localRecovered = mergePhotoCollections([parsed.archive || [], markedSheet]);
                    rebuildViews(localRecovered);
                } catch(e) {}
            } else rebuildViews([]);
            if (!db) { resolveGlobalPhotosReady(); return; }
            const safeAppId = appId.replace(/[^a-zA-Z0-9_-]/g, '_');
            const libraryDocRef = doc(db, 'artifacts', `${safeAppId}_public_data`, 'data', 'global_photo_library_v4');
            try {
                const v3SheetRef = doc(db, 'artifacts', `${safeAppId}_public_data`, 'data', 'global_sheet_photos_v3');
                const v3ArchiveRef = doc(db, 'artifacts', `${safeAppId}_public_data`, 'data', 'global_archive_photos_v3');
                const photoBackupCol = collection(db, 'artifacts', `${safeAppId}_public_data`, 'backups_photo_library');
                const sheetBackupCol = collection(db, 'artifacts', `${safeAppId}_public_data`, 'backups_sheet');
                const archiveBackupCol = collection(db, 'artifacts', `${safeAppId}_public_data`, 'backups_archive');
                const [v4Snap, sheetSnap, archiveSnap, photoBackups, sheetBackups, archiveBackups] = await Promise.all([
                    getDoc(libraryDocRef), getDoc(v3SheetRef), getDoc(v3ArchiveRef),
                    getDocs(photoBackupCol), getDocs(sheetBackupCol), getDocs(archiveBackupCol)
                ]);
                const recoveryDates = new Set(['2026-07-22', '2026-07-23']);
                const legacyCollections = [localRecovered, v4Snap.exists() ? (v4Snap.data().photos || []) : []];
                if (sheetSnap.exists()) legacyCollections.push((sheetSnap.data().sheet || []).map(x => ({...x, includeInSheet:true})));
                if (archiveSnap.exists()) legacyCollections.push(archiveSnap.data().archive || []);
                photoBackups.forEach(item => { if (recoveryDates.has(item.id)) legacyCollections.push(item.data().photos || []); });
                sheetBackups.forEach(item => { if (recoveryDates.has(item.id)) legacyCollections.push((item.data().sheet || []).map(x => ({...x, includeInSheet:true}))); });
                archiveBackups.forEach(item => { if (recoveryDates.has(item.id)) legacyCollections.push(item.data().archive || []); });
                const recovered = mergePhotoCollections(legacyCollections);
                if (recovered.length) {
                    rebuildViews(recovered);
                    await setDoc(libraryDocRef, {
                        photos: recovered,
                        savedAt: new Date().toISOString(),
                        migratedFrom: 'v3-and-2026-07-22-23-backups'
                    });
                }
            } catch (error) {
                console.debug('Legacy photo recovery deferred', error);
            }
            onSnapshot(libraryDocRef, snap => {
                if (snap.exists()) rebuildViews(snap.data().photos || []);
                resolveGlobalPhotosReady();
            }, () => resolveGlobalPhotosReady());
        }

        async function saveGlobalPublicPhotosToCloud() {
            sheetPhotoList = archiveList.filter(x => x.includeInSheet);
            localStorage.setItem('smart_construction_global_public_photos', JSON.stringify({ archive: archiveList }));
            if (!db) return true;
            await Promise.race([
                globalPhotosReadyPromise,
                new Promise(resolve => setTimeout(resolve, 6000))
            ]);
            try {
                const safeAppId = appId.replace(/[^a-zA-Z0-9_-]/g, '_');
                const libraryDocRef = doc(db, 'artifacts', `${safeAppId}_public_data`, 'data', 'global_photo_library_v4');
                await setDoc(libraryDocRef, { photos: archiveList, savedAt: new Date().toISOString() });
                createAutoBackup();
                return true;
            } catch(e) {
                showToast(`⚠️ 클라우드 저장 실패: ${e && e.message ? e.message : '알 수 없는 오류'}`);
                return false;
            }
        }

        async function createAutoBackup() {
            if (!db) return;
            if (archiveList.length === 0 && sheetPhotoList.length === 0) return;
            try {
                const safeAppId = appId.replace(/[^a-zA-Z0-9_-]/g, '_');
                const todayStr = getLocalDateString();
                const backupRef = doc(db, 'artifacts', `${safeAppId}_public_data`, 'backups_photo_library', todayStr);
                await setDoc(backupRef, { photos: archiveList, savedAt: new Date().toISOString() });
            } catch(e) {}
        }

        window.manualBackupNow = async function() {
            if (!db) {
                showToast("클라우드에 연결되어 있지 않아 백업할 수 없습니다.");
                return;
            }
            await createAutoBackup();
            showToast("💾 지금 상태로 백업을 저장했습니다.");
        };

        window.loadBackupList = async function() {
            const listEl = document.getElementById('backupListContainer');
            if (!db) {
                listEl.innerHTML = `<div class="text-center text-xs text-rose-500 py-4">클라우드에 연결되어 있지 않습니다.</div>`;
                return;
            }
            listEl.innerHTML = `<div class="text-center text-xs text-slate-400 py-4">불러오는 중...</div>`;
            try {
                const safeAppId = appId.replace(/[^a-zA-Z0-9_-]/g, '_');
                const sheetBackupsCol = collection(db, 'artifacts', `${safeAppId}_public_data`, 'backups_sheet');
                const archiveBackupsCol = collection(db, 'artifacts', `${safeAppId}_public_data`, 'backups_archive');
                const photoBackupsCol = collection(db, 'artifacts', `${safeAppId}_public_data`, 'backups_photo_library');
                const [sheetSnap, archiveSnap, photoSnap] = await Promise.all([getDocs(sheetBackupsCol), getDocs(archiveBackupsCol), getDocs(photoBackupsCol)]);

                const merged = {};
                sheetSnap.forEach(d => {
                    const data = d.data();
                    merged[d.id] = merged[d.id] || {};
                    merged[d.id].sheetCount = (data.sheet || []).length;
                    merged[d.id].savedAt = data.savedAt;
                });
                archiveSnap.forEach(d => {
                    const data = d.data();
                    merged[d.id] = merged[d.id] || {};
                    merged[d.id].archiveCount = (data.archive || []).length;
                    merged[d.id].savedAt = merged[d.id].savedAt || data.savedAt;
                });
                photoSnap.forEach(d => {
                    const data = d.data();
                    merged[d.id] = merged[d.id] || {};
                    merged[d.id].photoCount = (data.photos || []).length;
                    merged[d.id].savedAt = data.savedAt || merged[d.id].savedAt;
                });

                const ids = Object.keys(merged).sort((a, b) => b.localeCompare(a));
                if (ids.length === 0) {
                    listEl.innerHTML = `<div class="text-center text-xs text-slate-400 py-4">저장된 백업이 아직 없습니다.</div>`;
                    return;
                }
                listEl.innerHTML = ids.map(id => {
                    const b = merged[id];
                    const count = b.photoCount ?? ((b.sheetCount || 0) + (b.archiveCount || 0));
                    const savedAtStr = b.savedAt ? new Date(b.savedAt).toLocaleString() : '';
                    return `
                        <div class="flex items-center justify-between bg-slate-50 border border-slate-200 rounded-xl px-4 py-3">
                            <div>
                                <p class="text-xs font-bold text-slate-800">${id}</p>
                                <p class="text-[10px] text-slate-400 mt-0.5">사진 ${count}장 · 마지막 저장: ${savedAtStr}</p>
                            </div>
                            <button onclick="restoreFromBackup('${id}')" class="px-3 py-1.5 bg-blue-600 hover:bg-blue-700 text-white text-xs font-bold rounded-lg flex items-center gap-1.5">
                                <i class="fa-solid fa-clock-rotate-left"></i> 이 시점으로 복원
                            </button>
                        </div>
                    `;
                }).join('');
            } catch(e) {
                listEl.innerHTML = `<div class="text-center text-xs text-rose-500 py-4">백업 목록을 불러오지 못했습니다.</div>`;
            }
        };

        window.restoreFromBackup = async function(backupId) {
            if (!db) return;
            if (!window.confirm(`'${backupId}' 백업 시점으로 복원하시겠습니까?\n\n현재 데이터는 복원 전 상태로 별도 백업된 후 교체됩니다.`)) return;
            try {
                const safeAppId = appId.replace(/[^a-zA-Z0-9_-]/g, '_');

                const preRestoreId = `복원전_${new Date().toISOString().replace(/[:.]/g, '-')}`;
                const preSheetRef = doc(db, 'artifacts', `${safeAppId}_public_data`, 'backups_sheet', preRestoreId);
                const preArchiveRef = doc(db, 'artifacts', `${safeAppId}_public_data`, 'backups_archive', preRestoreId);
                await Promise.all([
                    setDoc(preSheetRef, { sheet: sheetPhotoList, savedAt: new Date().toISOString() }),
                    setDoc(preArchiveRef, { archive: archiveList, savedAt: new Date().toISOString() })
                ]);

                const sheetBackupRef = doc(db, 'artifacts', `${safeAppId}_public_data`, 'backups_sheet', backupId);
                const archiveBackupRef = doc(db, 'artifacts', `${safeAppId}_public_data`, 'backups_archive', backupId);
                const photoBackupRef = doc(db, 'artifacts', `${safeAppId}_public_data`, 'backups_photo_library', backupId);
                const [sheetSnap, archiveSnap, photoSnap] = await Promise.all([getDoc(sheetBackupRef), getDoc(archiveBackupRef), getDoc(photoBackupRef)]);

                if (!sheetSnap.exists() && !archiveSnap.exists() && !photoSnap.exists()) {
                    showToast("해당 백업을 찾을 수 없습니다.");
                    return;
                }
                const restoredSheet = sheetSnap.exists() ? (sheetSnap.data().sheet || []).map(x => ({...x, includeInSheet:true})) : [];
                const restoredArchive = archiveSnap.exists() ? (archiveSnap.data().archive || []) : [];
                const restoredPhotos = photoSnap.exists() ? (photoSnap.data().photos || []) : [];
                archiveList = mergePhotoCollections([restoredPhotos, restoredArchive, restoredSheet]);
                sheetPhotoList = archiveList.filter(x => x.includeInSheet);

                localStorage.setItem('smart_construction_global_public_photos', JSON.stringify({ archive: archiveList }));
                const libraryDocRef = doc(db, 'artifacts', `${safeAppId}_public_data`, 'data', 'global_photo_library_v4');
                await setDoc(libraryDocRef, { photos: archiveList, savedAt: new Date().toISOString(), restoredFrom: backupId });

                updateDashboardCounts();
                renderArchiveList();
                renderPrintSheets();
                if (isAdminMode) renderAdminPhotoEditorList();
                loadBackupList();
                showToast(`✅ '${backupId}' 시점으로 복원 완료!`);
            } catch(e) {
                showToast("복원 중 오류가 발생했습니다.");
            }
        };

        function setupGlobalSettingsSync() {
            const defaultSettings = {
                siteName: "NH농협은행 강릉 금융센터 신축공사",
                sheetTitle: "사 진 대 장",
                defaultDesc: "현장 시공 및 품질 검측 확인 작업 시행"
            };
            const localSettings = localStorage.getItem('smart_construction_global_settings');
            if (localSettings) {
                try { siteSettings = JSON.parse(localSettings); } catch(e) { siteSettings = defaultSettings; }
            }

            if (!db) return;
            const safeAppId = appId.replace(/[^a-zA-Z0-9_-]/g, '_');
            const settingsRef = doc(db, 'artifacts', `${safeAppId}_public_data`, 'data', 'global_system_settings_v1');

            unsubscribeSettings = onSnapshot(settingsRef, (docSnap) => {
                if (docSnap.exists()) {
                    siteSettings = docSnap.data();
                    localStorage.setItem('smart_construction_global_settings', JSON.stringify(siteSettings));
                    renderPrintSheets();
                    renderArchiveList();
                } else {
                    setDoc(settingsRef, defaultSettings).catch(() => {});
                }
            }, (err) => {});
        }

        window.saveAdminSettings = async function() {
            siteSettings.siteName = document.getElementById('adminSettingSiteName').value.trim() || "NH농협은행 강릉 금융센터 신축공사";
            siteSettings.sheetTitle = document.getElementById('adminSettingSheetTitle').value.trim() || "사 진 대 장";
            siteSettings.defaultDesc = document.getElementById('adminSettingDefaultDesc').value.trim() || "현장 시공 및 품질 검측 확인 작업 시행";

            const newLocation = `${siteSettings.siteName} 현장`;
            sheetPhotoList = sheetPhotoList.map(item => ({ ...item, location: newLocation }));
            archiveList = archiveList.map(item => ({ ...item, location: newLocation }));

            localStorage.setItem('smart_construction_global_settings', JSON.stringify(siteSettings));
            if (db) {
                try {
                    const safeAppId = appId.replace(/[^a-zA-Z0-9_-]/g, '_');
                    const settingsRef = doc(db, 'artifacts', `${safeAppId}_public_data`, 'data', 'global_system_settings_v1');
                    await setDoc(settingsRef, siteSettings);
                } catch(e) {}
            }
            await saveGlobalPublicPhotosToCloud();
            renderPrintSheets();
            renderArchiveList();
            if (isAdminMode) renderAdminPhotoEditorList();
            showToast("관리자 설정이 클라우드에 저장되었습니다.");
        };

        function setupGlobalUsersSync() {
            const defaultInitialUsers = [
                { userId: 'admin', name: '현장총괄 관리자', password: 'admin' },
                { userId: 'manager1', name: '김소장 (골조팀)', password: '123' },
                { userId: 'member1', name: '회원1 (현장반장)', password: '비번1' }
            ];

            const localUsers = localStorage.getItem('smart_construction_global_users');
            registeredUsers = localUsers ? JSON.parse(localUsers) : defaultInitialUsers;

            if (!db) return;

            const safeAppId = appId.replace(/[^a-zA-Z0-9_-]/g, '_');
            const usersRef = doc(db, 'artifacts', `${safeAppId}_public_data`, 'data', 'global_system_users_v2');
            
            unsubscribeUsers = onSnapshot(usersRef, (docSnap) => {
                if (docSnap.exists()) {
                    registeredUsers = docSnap.data().users || defaultInitialUsers;
                } else {
                    setDoc(usersRef, { users: registeredUsers }).catch(() => {});
                }
                localStorage.setItem('smart_construction_global_users', JSON.stringify(registeredUsers));
                if (isAdminMode) {
                    renderAdminUserTable();
                }
            }, (err) => {});
        }

        async function saveGlobalUsersToCloud() {
            localStorage.setItem('smart_construction_global_users', JSON.stringify(registeredUsers));
            if (!db) return;
            try {
                const safeAppId = appId.replace(/[^a-zA-Z0-9_-]/g, '_');
                const usersRef = doc(db, 'artifacts', `${safeAppId}_public_data`, 'data', 'global_system_users_v2');
                await setDoc(usersRef, { users: registeredUsers });
            } catch(e) {}
        }

        window.switchAuthTab = function(mode) {
            authMode = mode;
            const btnLogin = document.getElementById('authTabLogin');
            const btnRegister = document.getElementById('authTabRegister');
            const regFields = document.getElementById('registerExtraFields');
            const submitBtn = document.getElementById('authSubmitBtn');

            if (mode === 'login') {
                if (btnLogin) btnLogin.className = "flex-1 py-2.5 rounded-lg bg-white shadow text-blue-600 transition";
                if (btnRegister) btnRegister.className = "flex-1 py-2.5 rounded-lg text-slate-500 transition";
                if (regFields) regFields.classList.add('hidden');
                if (submitBtn) submitBtn.innerText = "로그인하기";
            } else {
                if (btnLogin) btnLogin.className = "flex-1 py-2.5 rounded-lg text-slate-500 transition";
                if (btnRegister) btnRegister.className = "flex-1 py-2.5 rounded-lg bg-white shadow text-blue-600 transition";
                if (regFields) regFields.classList.remove('hidden');
                if (submitBtn) submitBtn.innerText = "회원가입 완료하기";
            }
        };

        window.handleAuthSubmit = async function() {
            const uidInput = document.getElementById('authUserId').value.trim();
            const pwdInput = document.getElementById('authPassword').value.trim();
            const nameInput = document.getElementById('authName').value.trim();

            if (!uidInput || !pwdInput) {
                showToast("아이디와 비밀번호를 모두 입력해 주세요.");
                return;
            }

            if (authMode === 'register') {
                if (!nameInput) {
                    showToast("이름 및 소속/직급을 입력해 주세요.");
                    return;
                }
                if (registeredUsers.some(u => u.userId === uidInput)) {
                    showToast("이미 존재하는 아이디입니다.");
                    return;
                }
                const newUser = { userId: uidInput, name: nameInput, password: pwdInput };
                registeredUsers.push(newUser);
                await saveGlobalUsersToCloud();
                
                currentUser = newUser;
                sessionStorage.setItem('smart_construction_current_user', JSON.stringify(currentUser));
                showToast("회원가입 및 로그인 완료!");
                unlockApp(currentUser);
            } else {
                const found = registeredUsers.find(u => u.userId === uidInput && u.password === pwdInput);
                if (!found) {
                    showToast("아이디 또는 비밀번호가 올바르지 않습니다.");
                    return;
                }
                currentUser = found;
                sessionStorage.setItem('smart_construction_current_user', JSON.stringify(currentUser));
                showToast(`${currentUser.name}님 환영합니다!`);
                unlockApp(currentUser);
            }
        };

        function unlockApp(user) {
            document.getElementById('authOverlay').classList.add('hidden');
            document.getElementById('mainHeader').classList.remove('hidden');
            document.getElementById('mainContentArea').classList.remove('hidden');
            
            const titleEl = document.getElementById('welcomeUserTitle');
            if (titleEl) titleEl.innerText = `${user.name}님 환영합니다 | ${siteSettings.siteName}`;

            isAdminMode = false;
            updateAdminButtonState();
        }

        window.lockApp = function() {
            document.getElementById('authOverlay').classList.remove('hidden');
            document.getElementById('mainHeader').classList.add('hidden');
            document.getElementById('mainContentArea').classList.add('hidden');
        };

        window.handleLogout = function() {
            sessionStorage.removeItem('smart_construction_current_user');
            localStorage.removeItem('smart_construction_current_user');
            currentUser = null;
            isAdminMode = false;
            updateAdminButtonState();
            lockApp();
            showToast("로그아웃 되었습니다.");
        };

        let deferredInstallPrompt = null;
        window.addEventListener('beforeinstallprompt', (e) => {
            e.preventDefault();
            deferredInstallPrompt = e;
        });

        window.handleAddToHomeScreen = async function() {
            if (deferredInstallPrompt) {
                deferredInstallPrompt.prompt();
                await deferredInstallPrompt.userChoice;
                deferredInstallPrompt = null;
                return;
            }
            const ua = navigator.userAgent;
            const isIOS = /iphone|ipad|ipod/i.test(ua);
            const isAndroid = /android/i.test(ua);
            let msg = "";
            if (isIOS) {
                msg = "하단(또는 상단)의 공유 버튼(⬆️)을 누른 뒤, '홈 화면에 추가'를 선택해주세요.";
            } else if (isAndroid) {
                msg = "브라우저 우측 상단 메뉴(⋮)를 누른 뒤, '홈 화면에 추가' 또는 '앱 설치'를 선택해주세요.";
            } else {
                msg = "브라우저 메뉴에서 '홈 화면에 추가' 또는 '앱 설치' 항목을 찾아 선택해주세요.";
            }
            document.getElementById('pwaInstallInstructions').innerText = msg;
            document.getElementById('pwaInstallModal').classList.remove('hidden');
        };

        window.handleAdminModeToggle = function() {
            if (!isAdminMode) {
                document.getElementById('adminPromptModal').classList.remove('hidden');
                document.getElementById('adminInputPassword').value = '';
                document.getElementById('adminInputPassword').focus();
            } else {
                closeSubMenu();
                highlightMainNav(null);
                switchTab('tabAdminView');
            }
        };

        window.closeAdminPrompt = function() {
            document.getElementById('adminPromptModal').classList.add('hidden');
        };

        window.verifyAdminPassword = function() {
            const pwd = document.getElementById('adminInputPassword').value.trim();
            if (pwd === "1773" || pwd === "admin") {
                isAdminMode = true;
                closeAdminPrompt();
                updateAdminButtonState();
                closeSubMenu();
                highlightMainNav(null);
                switchTab('tabAdminView');
                renderAdminUserTable();
                renderAdminPhotoEditorList();
                renderArchiveList();
                renderPrintSheets();
                renderSchedule();
                renderSiteSchedules();
                showToast("👑 관리자 모드가 성공적으로 활성화되었습니다.");
            } else {
                showToast("관리자 비밀번호가 올바르지 않습니다.");
            }
        };

        function updateAdminButtonState() {
            const btnTabAdmin = document.getElementById('btnTabAdminView');
            const adminModeBtnIcon = document.getElementById('adminModeBtnIcon');
            const adminModeBtnText = document.getElementById('adminModeBtnText');

            if (isAdminMode) {
                if (adminModeBtnIcon) adminModeBtnIcon.className = "fa-solid fa-crown text-amber-300";
                if (adminModeBtnText) adminModeBtnText.innerText = "관리자모드";
                if (btnTabAdmin) btnTabAdmin.className = "px-3 py-1.5 rounded-lg bg-amber-500 text-slate-900 hover:bg-amber-400 transition flex items-center gap-1.5 font-extrabold";
                document.querySelectorAll('.admin-only').forEach(el => el.classList.remove('hidden'));
            } else {
                if (adminModeBtnIcon) adminModeBtnIcon.className = "fa-solid fa-lock";
                if (adminModeBtnText) adminModeBtnText.innerText = "ADMIN 인증";
                if (btnTabAdmin) btnTabAdmin.className = "px-3 py-1.5 rounded-lg bg-amber-500/20 text-amber-300 hover:bg-amber-500 hover:text-white transition flex items-center gap-1.5 font-bold";
                document.querySelectorAll('.admin-only').forEach(el => el.classList.add('hidden'));
            }
        }

        window.exitAdminMode = function() {
            isAdminMode = false;
            updateAdminButtonState();
            goHome();
            renderArchiveList();
            renderPrintSheets();
            renderSchedule();
            showToast("일반 모드로 전환되었습니다.");
        };

        const ALL_TAB_IDS = ['tabHomeView', 'tabDailyView', 'tabPrintSheetView', 'tabArchiveView', 'tabAdminView', 'tabScheduleView',
            'tabMaterialApprovalView', 'tabMaterialInspectionView', 'tabQualityTestView',
            'tabDrawingOverviewView', 'tabDrawingArchitectureView', 'tabDrawingStructureView', 'tabDrawingPerspectiveView', 'tabDrawing3DView'];

        window.switchTab = function(tabId) {
            ALL_TAB_IDS.forEach(id => {
                const el = document.getElementById(id);
                if (el) el.classList.add('hidden');
            });

            const adminBtn = document.getElementById('btnTabAdminView');
            if (adminBtn) {
                if (tabId === 'tabAdminView') {
                    adminBtn.className = "px-3 py-1.5 rounded-lg bg-amber-500 text-slate-900 hover:bg-amber-400 transition flex items-center gap-1.5 font-extrabold";
                } else {
                    adminBtn.className = "px-3 py-1.5 rounded-lg bg-amber-500/20 text-amber-300 hover:bg-amber-500 hover:text-white transition flex items-center gap-1.5 font-bold";
                }
            }

            const targetEl = document.getElementById(tabId);
            if (targetEl) targetEl.classList.remove('hidden');

            if (tabId === 'tabAdminView' && isAdminMode) {
                renderAdminUserTable();
                renderAdminPhotoEditorList();
            }

            if (tabId === 'tabPrintSheetView') {
                renderPrintSheets();
            }

            if (tabId === 'tabArchiveView') {
                renderArchiveList();
            }
        };

        const subMenuConfig = {
            photo: [
                { id: 'tabDailyView', icon: 'fa-camera', label: '사진촬영' },
                { id: 'tabPrintSheetView', icon: 'fa-file-lines', label: '준공대지' },
                { id: 'tabArchiveView', icon: 'fa-images', label: '보관함' }
            ],
            quality: [
                { id: 'tabMaterialApprovalView', icon: 'fa-file-signature', label: '자재공급승인요청서' },
                { id: 'tabMaterialInspectionView', icon: 'fa-magnifying-glass', label: '자재검수요청서' },
                { id: 'tabQualityTestView', icon: 'fa-vial', label: '품질시험' }
            ],
            drawing: [
                { id: 'tabDrawingArchitectureView', icon: 'fa-building', label: '건축' },
                { id: 'tabDrawingStructureView', icon: 'fa-cubes-stacked', label: '구조' },
                { id: 'tabDrawingPerspectiveView', icon: 'fa-image', label: '조감도' },
                { id: 'tabDrawing3DView', icon: 'fa-cube', label: '3D' }
            ],
            schedule: [
                { id: 'tabScheduleView', icon: 'fa-chart-gantt', label: '통합 공정표' }
            ]
        };
        let currentSubCategory = null;

        function highlightMainNav(activeKey) {
            ['home', 'photo', 'quality', 'drawing', 'schedule'].forEach(key => {
                const btn = document.getElementById('btnMain_' + key);
                if (!btn) return;
                btn.className = (key === activeKey)
                    ? "px-3 py-1.5 rounded-lg bg-blue-600 text-white transition flex items-center gap-1.5 shadow font-bold"
                    : "px-3 py-1.5 rounded-lg bg-slate-800 text-slate-300 hover:bg-slate-700 transition flex items-center gap-1.5 font-bold";
            });
        }

        function closeSubMenu() {
            currentSubCategory = null;
            const bar = document.getElementById('subMenuBar');
            if (!bar) return;
            bar.classList.add('hidden');
            const wrap = bar.querySelector('div');
            if (wrap) wrap.innerHTML = '';
        }

        function renderSubMenu(category, activeTabId) {
            const bar = document.getElementById('subMenuBar');
            const wrap = bar.querySelector('div');
            wrap.innerHTML = subMenuConfig[category].map(it => `
                <button onclick="selectSubTab('${category}','${it.id}')" id="btnSub_${it.id}" class="px-3 py-1.5 rounded-lg ${it.id === activeTabId ? 'bg-blue-500 text-white shadow' : 'bg-slate-700 text-slate-200 hover:bg-slate-600'} transition flex items-center gap-1.5 text-xs font-bold">
                    <i class="fa-solid ${it.icon}"></i> ${it.label}
                </button>
            `).join('');
            bar.classList.remove('hidden');
        }

        window.toggleSubMenu = function(category) {
            if (currentSubCategory === category) {
                closeSubMenu();
                highlightMainNav(null);
                return;
            }
            currentSubCategory = category;
            renderSubMenu(category, null);
            highlightMainNav(category);
        };

        window.selectSubTab = function(category, tabId) {
            currentSubCategory = category;
            renderSubMenu(category, tabId);
            highlightMainNav(category);
            switchTab(tabId);
        };

        window.goHome = function() {
            closeSubMenu();
            highlightMainNav('home');
            switchTab('tabHomeView');
        };

        window.handleMultiplePhotos = async function(event) {
            const files = event.target.files;
            if (!files || files.length === 0) return;
            const fileArray = Array.from(files);

            const processFile = (file) => new Promise((resolve) => {
                const reader = new FileReader();
                reader.onload = function(e) {
                    const img = new Image();
                    img.onload = function() {
                        const canvas = document.createElement('canvas');
                        const MAX_WIDTH = 800;
                        const MAX_HEIGHT = 800;
                        let width = img.width;
                        let height = img.height;

                        if (width > height) {
                            if (width > MAX_WIDTH) { height *= MAX_WIDTH / width; width = MAX_WIDTH; }
                        } else {
                            if (height > MAX_HEIGHT) { width *= MAX_HEIGHT / height; height = MAX_HEIGHT; }
                        }

                        canvas.width = width;
                        canvas.height = height;
                        const ctx = canvas.getContext('2d');
                        ctx.drawImage(img, 0, 0, width, height);

                        const compressedDataUrl = canvas.toDataURL('image/jpeg', 0.7);

                        resolve({
                            id: 'photo_' + Date.now() + '_' + Math.floor(Math.random()*10000),
                            imageUrl: compressedDataUrl,
                            date: getLocalDateString(), // Uses Korean local date
                            location: `${siteSettings.siteName} 현장`,
                            description: siteSettings.defaultDesc
                        });
                    };
                    img.src = e.target.result;
                };
                reader.readAsDataURL(file);
            });

            const newItems = await Promise.all(fileArray.map(processFile));

            const wasEmpty = activePhotoList.length === 0;
            activePhotoList.push(...newItems);
            if (wasEmpty && activePhotoList.length > 0) activeSelectedIndex = 0;
            renderThumbnailGrid();

            showToast(`${files.length}장의 사진이 등록되었습니다.`);
            event.target.value = '';
        };

        function renderThumbnailGrid() {
            const grid = document.getElementById('uploadThumbnailGrid');
            const badge = document.getElementById('photoCountBadge');
            if (badge) badge.innerText = `${activePhotoList.length}장 선택됨`;

            if (!grid) return;
            if (activePhotoList.length === 0) {
                grid.innerHTML = `<div class="col-span-full text-center py-6 text-slate-400 text-xs">등록된 사진이 없습니다. 위 영역을 눌러 사진을 추가하세요.</div>`;
                const descInput = document.getElementById('activePhotoDescInput');
                if (descInput) descInput.value = '';
                return;
            }

            grid.innerHTML = activePhotoList.map((item, idx) => `
                <div onclick="selectPhotoIndex(${idx})" class="relative group cursor-pointer border-2 rounded-xl overflow-hidden aspect-square bg-slate-100 ${activeSelectedIndex === idx ? 'border-blue-600 ring-2 ring-blue-400' : 'border-slate-200'}">
                    <img src="${item.imageUrl}" class="w-full h-full object-cover">
                    <div class="absolute inset-x-0 bottom-0 bg-slate-900/80 text-white text-[9px] px-1 py-0.5 text-center truncate">
                        #${idx+1}
                    </div>
                    <button type="button" onclick="event.stopPropagation(); removeSinglePhoto(${idx})" class="absolute top-1 right-1 bg-rose-600 text-white rounded-full w-5 h-5 flex items-center justify-center text-[10px] shadow opacity-0 group-hover:opacity-100 transition">
                        <i class="fa-solid fa-xmark"></i>
                    </button>
                </div>
            `).join('');

            if (activePhotoList[activeSelectedIndex]) {
                const descInput = document.getElementById('activePhotoDescInput');
                if (descInput) descInput.value = activePhotoList[activeSelectedIndex].description;
                const titleLabel = document.getElementById('activePhotoTitleLabel');
                if (titleLabel) titleLabel.innerHTML = `<i class="fa-solid fa-pen-to-square text-blue-600 mr-1"></i>선택된 사진 #${activeSelectedIndex+1} 개별 작업 설명`;
            }
        }

        window.selectPhotoIndex = function(idx) {
            activeSelectedIndex = idx;
            renderThumbnailGrid();
        };

        window.removeSinglePhoto = function(idx) {
            activePhotoList.splice(idx, 1);
            if (activeSelectedIndex >= activePhotoList.length) {
                activeSelectedIndex = Math.max(0, activePhotoList.length - 1);
            }
            renderThumbnailGrid();
            showToast("사진이 삭제되었습니다.");
        };

        window.clearAllPhotos = function() {
            activePhotoList = [];
            activeSelectedIndex = 0;
            renderThumbnailGrid();
            showToast("모든 사진이 초기화되었습니다.");
        };

        window.applyPreset = function(text) {
            if (activePhotoList.length === 0) {
                showToast("먼저 사진을 등록해 주세요.");
                return;
            }
            activePhotoList[activeSelectedIndex].description = text;
            const descInput = document.getElementById('activePhotoDescInput');
            if (descInput) descInput.value = text;
            renderThumbnailGrid();
            showToast(`사진 #${activeSelectedIndex+1}에 작업 내용이 적용되었습니다.`);
        };

        window.updateActivePhotoDesc = function(val) {
            if (activePhotoList.length > 0 && activePhotoList[activeSelectedIndex]) {
                activePhotoList[activeSelectedIndex].description = val;
            }
        };

        window.resetActivePhotoDesc = function() {
            if (activePhotoList.length > 0 && activePhotoList[activeSelectedIndex]) {
                activePhotoList[activeSelectedIndex].description = "";
                const descInput = document.getElementById('activePhotoDescInput');
                if (descInput) descInput.value = "";
                showToast("작업 설명이 초기화되었습니다.");
            }
        };

        const workTreeData = [
            { major: '현장준비·가설공사', groups: [
                { middle: '현장준비', items: ['가설 컨테이너 반입·안착', '경계점 확인 및 규준틀 측량', '부지 지장물 정리 및 평탄화'] },
                { middle: '가설공사', items: ['가설 펜스 및 방지망 설치', '가설전기·가설용수 설치', '안전시설물 설치'] }
            ]},
            { major: '토공·흙막이공사', groups: [
                { middle: '토공사', items: ['터파기 및 잔토 반출', '되메우기 및 다짐', '우·오수 관로 및 맨홀 설치'] },
                { middle: '흙막이·지정', items: ['흙막이 및 토류판 시공', 'CIP 시공', '지반보강 및 그라우팅'] }
            ]},
            { major: '철근콘크리트공사', groups: [
                { middle: '기초', items: ['기초 철근배근', '기초 거푸집', '기초 콘크리트 타설·양생'] },
                { middle: '벽체·기둥', items: ['벽체·기둥 철근배근', '벽체·기둥 거푸집', '벽체·기둥 콘크리트 타설·양생'] },
                { middle: '보·슬래브', items: ['보·슬래브 철근배근', '보·슬래브 거푸집', '보·슬래브 콘크리트 타설·양생'] }
            ]},
            { major: '건축마감공사', groups: [
                { middle: '조적·방수·타일', items: ['조적벽체 시공', '방수공사', '타일공사'] },
                { middle: '창호·유리·금속', items: ['창호 설치', '유리 설치', '금속공사'] },
                { middle: '미장·도장·수장', items: ['미장공사', '도장공사', '천장·벽체·바닥 수장공사'] }
            ]},
            { major: '부대·설비공사', groups: [
                { middle: '기계·전기설비', items: ['기계설비 배관', '전기 배관·배선', '기기 및 기구 설치'] },
                { middle: '외부·부대공사', items: ['외부 포장공사', '조경공사', '준공청소 및 정리'] }
            ]}
        ];

        function renderMobileWorkTree() {
            const wrap = document.getElementById('mobileWorkTree');
            if (!wrap) return;
            wrap.innerHTML = workTreeData.map((major, majorIndex) => `
                <details class="rounded-xl border border-slate-200 bg-white overflow-hidden">
                    <summary class="cursor-pointer list-none px-4 py-3 font-bold text-xs text-slate-800 bg-slate-50 flex justify-between items-center">
                        <span><i class="fa-solid fa-folder-tree text-blue-600 mr-2"></i>${major.major}</span>
                        <i class="fa-solid fa-chevron-down text-slate-400"></i>
                    </summary>
                    <div class="p-2 space-y-2">
                        ${major.groups.map((group, groupIndex) => `
                            <details class="rounded-lg border border-slate-200 overflow-hidden">
                                <summary class="cursor-pointer list-none px-3 py-2.5 font-bold text-xs text-slate-700 flex justify-between items-center">
                                    <span>${group.middle}</span><i class="fa-solid fa-chevron-down text-[10px] text-slate-400"></i>
                                </summary>
                                <div class="grid grid-cols-1 gap-1.5 p-2 pt-0">
                                    ${group.items.map(item => `
                                        <button type="button" onclick="applyWorkTreeItem('${major.major}','${group.middle}','${item}')" class="w-full rounded-lg border border-blue-100 bg-blue-50 px-3 py-2.5 text-left text-xs font-medium text-blue-950 hover:bg-blue-100">
                                            ${item}
                                        </button>
                                    `).join('')}
                                </div>
                            </details>
                        `).join('')}
                    </div>
                </details>
            `).join('');
        }

        window.applyWorkTreeItem = function(major, middle, item) {
            applyPreset(`${major} - ${middle} - ${item}`);
        };

        window.syncAndSaveAll = async function() {
            if (activePhotoList.length === 0) {
                showToast("동기화할 사진이 없습니다.");
                return;
            }

            const doSheet = document.getElementById('syncSheet').checked;
            const newArchiveItems = activePhotoList.map((item, i) => ({
                ...item,
                photoId: item.photoId || `photo_${Date.now()}_${i}`,
                includeInSheet: doSheet,
                savedAt: new Date().toLocaleString()
            }));
            archiveList = [...archiveList, ...newArchiveItems];
            sheetPhotoList = archiveList.filter(x => x.includeInSheet);

            const saved = await saveGlobalPublicPhotosToCloud();
            if (!saved) return;
            
            renderPrintSheets();
            renderArchiveList();
            updateDashboardCounts();

            let msg = "사진이 보관함에 저장되었습니다. ";
            if (doSheet) msg += "[준공대지에도 반영됨] ";
            showToast(msg);
            selectSubTab('photo', 'tabArchiveView');
        };

        function updateDashboardCounts() {
            const pCount = document.getElementById('dashPhotoCount');
            const sCount = document.getElementById('dashSheetCount');
            const aCount = document.getElementById('dashArchiveCount');
            if (pCount) pCount.innerText = `${archiveList.length}장`;
            if (sCount) sCount.innerText = `${Math.ceil(sheetPhotoList.length / 2)}페이지`;
            if (aCount) aCount.innerText = `${archiveList.length}개 항목`;
        }

        window.setSheetDateFilter = function(mode) {
            const input = document.getElementById('sheetFilterDate');
            if (!input) return;
            if (mode === 'all') input.value = '';
            else if (mode === 'today') input.value = getLocalDateString();
            else if (mode === 'yesterday') input.value = getYesterdayDateString();
            renderPrintSheets();
        };

        function renderPrintSheets() {
            const container = document.getElementById('a4SheetsContainer');
            const dateInput = document.getElementById('sheetFilterDate');
            const summaryEl = document.getElementById('sheetFilterSummary');
            if (!container) return;

            const filterDate = dateInput ? dateInput.value : '';

            let filteredPhotos = sheetPhotoList.map((item, originalIndex) => ({ ...item, originalIndex }));
            if (filterDate) {
                filteredPhotos = filteredPhotos.filter(item => item.date === filterDate);
            }

            if (summaryEl) {
                if (filterDate) {
                    summaryEl.innerText = `'${filterDate}' 날짜 사진 총 ${filteredPhotos.length}장 (${Math.ceil(filteredPhotos.length / 2)}페이지)`;
                } else {
                    summaryEl.innerText = `전체 날짜 사진 총 ${sheetPhotoList.length}장 (${Math.ceil(sheetPhotoList.length / 2)}페이지)`;
                }
            }

            if (filteredPhotos.length === 0) {
                container.innerHTML = `<div class="text-center py-12 text-slate-500 text-sm">
                    ${filterDate ? `'${filterDate}' 날짜에 등록된 준공대지 사진이 없습니다.` : '등록된 준공대지 데이터가 없습니다. 첫 번째 탭에서 사진을 등록해 주세요.'}
                </div>`;
                return;
            }

            const formatYM = (dateStr) => {
                if (!dateStr) return '날짜미상';
                const parts = dateStr.split('-');
                if (parts.length >= 2) return `${parts[0].slice(2)}년 ${parts[1]}월`;
                return dateStr;
            };
            const formatFullDate = (dateStr) => {
                if (!dateStr || dateStr === '날짜미상') return '날짜 미상';
                const parts = dateStr.split('-');
                if (parts.length === 3) return `${parts[0]}년 ${parts[1]}월 ${parts[2]}일`;
                return dateStr;
            };

            // 날짜와 관계없이 모든 사진을 연속으로 연결해 A4 2장씩 배치한다.
            const grouped = { all: filteredPhotos };
            const sortedDates = ['all'];

            let html = '';
            let pageIndex = 0;

            sortedDates.forEach(dateKey => {
                const items = grouped[dateKey];

                for (let i = 0; i < items.length; i += 2) {
                    const p1 = items[i];
                    const p2 = items[i+1];
                    pageIndex++;

                    html += `
                        <div class="print-page-wrapper">
                        <div id="printSheetPage_${pageIndex}" class="print-page bg-white shadow-2xl rounded-xl border border-slate-400 p-8 flex flex-col justify-start relative" style="width: 210mm; min-height: 297mm; font-family: 'Inter', sans-serif;">
                            <table class="w-full border-collapse border-2 border-black text-center mb-1">
                                <thead>
                                    <tr>
                                        <th class="border-2 border-black py-3 bg-white text-black text-xl font-black tracking-widest">
                                            ${siteSettings.sheetTitle} (페이지 ${pageIndex})
                                        </th>
                                    </tr>
                                </thead>
                            </table>
                            <div class="border-2 border-black mb-6 flex flex-col relative group">
                                ${isAdminMode ? `<button onclick="deleteSheetPhotoIndex(${p1.originalIndex})" class="absolute top-2 right-2 bg-rose-600 hover:bg-rose-700 text-white w-8 h-8 rounded-full flex items-center justify-center text-xs shadow-lg z-10 no-print" title="이 사진 삭제">
                                    <i class="fa-solid fa-trash-can"></i>
                                </button>` : ''}
                                <div class="w-full bg-white p-3 flex items-center justify-center overflow-hidden" style="height: 360px;">
                                    <img src="${p1.imageUrl}" class="w-full h-full object-cover">
                                </div>
                                <table class="w-full border-t-2 border-black border-collapse text-xs">
                                    <tr>
                                        <td class="border-r-2 border-black bg-slate-100 py-2.5 px-3 font-bold text-center w-20 text-slate-900">촬영일</td>
                                        <td class="border-r-2 border-black py-2.5 px-3 text-center font-medium w-36 text-slate-900">${formatYM(p1.date)}</td>
                                        <td class="border-r-2 border-black bg-slate-100 py-2.5 px-3 font-bold text-center w-20 text-slate-900">내용</td>
                                        <td class="py-2.5 px-4 font-bold text-left text-slate-900">${p1.description || p1.location}</td>
                                    </tr>
                                </table>
                            </div>

                            ${p2 ? `
                            <div class="border-2 border-black flex flex-col relative group">
                                ${isAdminMode ? `<button onclick="deleteSheetPhotoIndex(${p2.originalIndex})" class="absolute top-2 right-2 bg-rose-600 hover:bg-rose-700 text-white w-8 h-8 rounded-full flex items-center justify-center text-xs shadow-lg z-10 no-print" title="이 사진 삭제">
                                    <i class="fa-solid fa-trash-can"></i>
                                </button>` : ''}
                                <div class="w-full bg-white p-3 flex items-center justify-center overflow-hidden" style="height: 360px;">
                                    <img src="${p2.imageUrl}" class="w-full h-full object-cover">
                                </div>
                                <table class="w-full border-t-2 border-black border-collapse text-xs">
                                    <tr>
                                        <td class="border-r-2 border-black bg-slate-100 py-2.5 px-3 font-bold text-center w-20 text-slate-900">촬영일</td>
                                        <td class="border-r-2 border-black py-2.5 px-3 text-center font-medium w-36 text-slate-900">${formatYM(p2.date)}</td>
                                        <td class="border-r-2 border-black bg-slate-100 py-2.5 px-3 font-bold text-center w-20 text-slate-900">내용</td>
                                        <td class="py-2.5 px-4 font-bold text-left text-slate-900">${p2.description || p2.location}</td>
                                    </tr>
                                </table>
                            </div>` : ''}

                            <div class="text-right text-[10px] text-slate-400 pt-4 border-t mt-auto">
                                ${siteSettings.siteName} 스마트건설관리 시스템
                            </div>
                        </div>
                        </div>
                    `;
                }
            });

            container.innerHTML = html;
            applyMobilePrintScale();
        }

        function applyMobilePrintScale() {
            if (window.innerWidth >= 640) return;
            const A4_W = 794, A4_H = 1123;
            document.querySelectorAll('.print-page-wrapper').forEach(wrapper => {
                const scale = wrapper.clientWidth / A4_W;
                const page = wrapper.querySelector('.print-page');
                if (page) page.style.transform = `scale(${scale})`;
                wrapper.style.height = `${A4_H * scale}px`;
            });
        }
        window.addEventListener('resize', () => {
            if (document.getElementById('tabPrintSheetView') && !document.getElementById('tabPrintSheetView').classList.contains('hidden')) {
                applyMobilePrintScale();
            }
        });

        window.downloadAllSheetsAsImages = async function() {
            if (sheetPhotoList.length === 0) {
                showToast("저장할 준공대지가 없습니다.");
                return;
            }
            if (typeof html2canvas === 'undefined' || typeof JSZip === 'undefined') {
                showToast("이미지 저장 기능을 불러오는 중입니다. 잠시 후 다시 시도해 주세요.");
                return;
            }
            showToast("🖼️ 페이지를 이미지로 변환하는 중입니다...");
            const pages = document.querySelectorAll('#a4SheetsContainer .print-page');
            pages.forEach(p => p.style.transform = 'none');
            try {
                const zip = new JSZip();
                for (let i = 0; i < pages.length; i++) {
                    const canvas = await html2canvas(pages[i], { scale: 2, useCORS: true });
                    const base64 = canvas.toDataURL('image/png').split(',')[1];
                    zip.file(`준공대지_페이지${i+1}.png`, base64, { base64: true });
                }
                const blob = await zip.generateAsync({ type: 'blob' });
                const link = document.createElement('a');
                link.download = `${siteSettings.siteName}_준공대지_이미지.zip`;
                link.href = URL.createObjectURL(blob);
                link.click();
                showToast("✅ 이미지(zip) 저장 완료!");
            } finally {
                applyMobilePrintScale();
            }
        };

        window.downloadAllSheetsAsPDF = async function() {
            if (sheetPhotoList.length === 0) {
                showToast("PDF로 만들 사진이 없습니다.");
                return;
            }
            if (typeof window.jspdf === 'undefined' || typeof html2canvas === 'undefined') {
                showToast("PDF 생성 기능을 불러오는 중입니다. 잠시 후 다시 시도해 주세요.");
                return;
            }
            showToast("📄 전체 준공대지를 하나의 PDF로 이어붙이는 중입니다...");
            const pages = document.querySelectorAll('#a4SheetsContainer .print-page');
            pages.forEach(p => p.style.transform = 'none');
            try {
                const { jsPDF } = window.jspdf;
                const pdf = new jsPDF('p', 'mm', 'a4');
                for (let i = 0; i < pages.length; i++) {
                    const canvas = await html2canvas(pages[i], { scale: 2, useCORS: true });
                    const imgData = canvas.toDataURL('image/jpeg', 0.92);
                    if (i > 0) pdf.addPage();
                    pdf.addImage(imgData, 'JPEG', 0, 0, 210, 297);
                }
                pdf.save(`${siteSettings.siteName}_준공사진대지_전체.pdf`);
                showToast("✅ 전체 PDF 저장 완료!");
            } finally {
                applyMobilePrintScale();
            }
        };

        window.deleteSheetPhotoIndex = async function(idx) {
            if (!isAdminMode) {
                showToast("관리자 모드에서만 준공대지 사진을 삭제할 수 있습니다.");
                return;
            }
            if (!window.confirm(`정말로 준공대지 #${idx+1} 사진을 삭제하시겠습니까?`)) return;
            const target=sheetPhotoList[idx];
            const source=archiveList.find(x => x.photoId === target?.photoId || x.imageUrl === target?.imageUrl);
            if (source) source.includeInSheet=false;
            sheetPhotoList=archiveList.filter(x => x.includeInSheet);
            await saveGlobalPublicPhotosToCloud();
            renderPrintSheets();
            renderAdminPhotoEditorList();
            showToast("준공대지 사진이 삭제되었습니다.");
        };

        window.setArchiveDateFilter = function(mode) {
            const input = document.getElementById('archiveFilterDate');
            if (!input) return;
            if (mode === 'today') input.value = getLocalDateString();
            else if (mode === 'yesterday') input.value = getYesterdayDateString();
            renderArchiveList();
        };

        window.renderArchiveList = function() {
            const grid = document.getElementById('archiveGrid');
            const filterDate = document.getElementById('archiveFilterDate').value;
            if (!grid) return;

            let filtered = archiveList.map((item, originalIndex) => ({ ...item, originalIndex }));
            if (filterDate) {
                filtered = filtered.filter(item => item.date === filterDate);
            }

            if (filtered.length === 0) {
                grid.innerHTML = `<div class="col-span-full text-center py-12 text-slate-400 text-xs bg-white rounded-2xl border border-slate-200">
                    ${filterDate ? `'${filterDate}' 날짜에 보관된 사진이 없습니다.` : '보관된 항목이 없습니다. (사진을 등록하고 클라우드 동기화 또는 준공대지 반영을 진행해 주세요.)'}
                </div>`;
                return;
            }

            grid.innerHTML = filtered.map(item => `
                <div class="bg-white border border-slate-200 rounded-2xl overflow-hidden shadow-sm flex flex-col justify-between relative group">
                    <button onclick="downloadArchivePhoto(${item.originalIndex})" class="absolute top-2 ${isAdminMode ? 'right-12' : 'right-2'} bg-blue-600 hover:bg-blue-700 text-white w-8 h-8 rounded-full flex items-center justify-center text-xs shadow-lg z-10 transition" title="이 사진 다운로드">
                        <i class="fa-solid fa-download"></i>
                    </button>
                    ${isAdminMode ? `
                    <button onclick="deleteArchivePhotoIndex(${item.originalIndex})" class="absolute top-2 right-2 bg-rose-600 hover:bg-rose-700 text-white w-8 h-8 rounded-full flex items-center justify-center text-xs shadow-lg z-10 transition" title="보관함에서 삭제">
                        <i class="fa-solid fa-trash-can"></i>
                    </button>
                    ` : ''}
                    <div>
                        <div class="h-48 overflow-hidden bg-slate-100 flex items-center justify-center">
                            <img src="${item.imageUrl}" class="w-full h-full object-cover">
                        </div>
                        <div class="p-4 space-y-2">
                            <div class="flex justify-between items-center text-[11px] text-slate-500">
                                <span><i class="fa-regular fa-calendar mr-1"></i> ${item.date}</span>
                                <span class="bg-emerald-50 text-emerald-600 px-2 py-0.5 rounded-full font-bold">공용 동기화 완료</span>
                            </div>
                            <h4 class="font-bold text-xs text-slate-800">${item.location}</h4>
                            <p class="text-xs text-slate-600 bg-slate-50 p-2.5 rounded-xl border border-slate-100">${item.description}</p>
                        </div>
                    </div>
                </div>
            `).join('');
        };

        window.deleteArchivePhotoIndex = async function(idx) {
            if (!isAdminMode) {
                showToast("관리자만 삭제할 수 있습니다.");
                return;
            }
            if (!window.confirm(`보관함에서 해당 사진을 정말로 삭제하시겠습니까?`)) return;
            archiveList.splice(idx, 1);
            await saveGlobalPublicPhotosToCloud();
            showToast("보관함 사진이 삭제되었습니다.");
        };

        window.downloadArchivePhoto = function(idx) {
            const item = archiveList[idx];
            if (!item) return;
            const link = document.createElement('a');
            link.download = `${siteSettings.siteName}_${item.date}_${idx+1}.jpg`;
            link.href = item.imageUrl;
            link.click();
        };

        window.downloadAllArchivePhotos = async function() {
            const filterDate = document.getElementById('archiveFilterDate').value;
            let targets = archiveList.map((item, originalIndex) => ({ ...item, originalIndex }));
            if (filterDate) targets = targets.filter(item => item.date === filterDate);

            if (targets.length === 0) {
                showToast("다운로드할 사진이 없습니다.");
                return;
            }
            if (typeof JSZip === 'undefined') {
                showToast("압축 다운로드 기능을 불러오는 중입니다. 잠시 후 다시 시도해 주세요.");
                return;
            }
            showToast(`📦 사진 ${targets.length}장을 압축하는 중입니다...`);
            const zip = new JSZip();
            targets.forEach((item, i) => {
                const base64Data = item.imageUrl.split(',')[1];
                zip.file(`${item.date}_${i+1}.jpg`, base64Data, { base64: true });
            });
            const blob = await zip.generateAsync({ type: 'blob' });
            const link = document.createElement('a');
            link.download = `보관함사진_${new Date().toISOString().slice(0,10)}.zip`;
            link.href = URL.createObjectURL(blob);
            link.click();
            showToast("✨ 전체 사진 압축 다운로드 완료!");
        };

        window.resetArchiveFilter = function() {
            document.getElementById('archiveFilterDate').value = '';
            renderArchiveList();
        };

        window.downloadSinglePortfolioImage = async function() {
            const filterInput = document.getElementById('archiveFilterDate');
            const targetDate = (filterInput && filterInput.value) || getLocalDateString();
            const todaysPhotos = archiveList.filter(item => item.date === targetDate);

            if (todaysPhotos.length === 0) {
                showToast(`${targetDate} 날짜에 등록된 사진이 없습니다.`);
                return;
            }
            showToast("🖼️ 세로형 1장 포트폴리오 이미지를 생성 중입니다...");

            document.getElementById('exportBadgeSiteName').innerText = siteSettings.siteName;
            document.getElementById('exportMainTitle').innerText = `현장사진대지(총 ${todaysPhotos.length}장)`;
            document.getElementById('exportDateLabel').innerText = `날짜: ${targetDate}`;

            const cardsGrid = document.getElementById('exportCardsGrid');
            cardsGrid.innerHTML = todaysPhotos.map((item, idx) => `
                <div>
                    <div class="w-full h-[320px] bg-slate-200 rounded-xl overflow-hidden flex items-center justify-center">
                        <img src="${item.imageUrl}" class="w-full h-full object-cover">
                    </div>
                    <div class="px-1 pt-2">
                        <p class="text-xl font-black text-slate-900 leading-snug">${item.description || '특이사항 없음'}</p>
                    </div>
                </div>
            `).join('');

            const wrapper = document.getElementById('singlePortfolioExportWrapper');
            try {
                const canvas = await html2canvas(wrapper, { scale: 2, useCORS: true });
                const link = document.createElement('a');
                link.download = `현장세로형포트폴리오_${targetDate}.png`;
                link.href = canvas.toDataURL('image/png');
                link.click();
                showToast("✨ 세로형 1장 포트폴리오 이미지 저장 완료!");
            } catch (e) {
                showToast("이미지 생성 중 오류가 발생했습니다.");
            }
        };

        window.setAdminDateFilter = function(mode) {
            const input = document.getElementById('adminFilterDate');
            if (!input) return;
            if (mode === 'all') input.value = '';
            else if (mode === 'today') input.value = getLocalDateString();
            else if (mode === 'yesterday') input.value = getYesterdayDateString();
            renderAdminPhotoEditorList();
        };

        window.renderAdminPhotoEditorList = function() {
            const container = document.getElementById('adminPhotoEditorList');
            const badge = document.getElementById('adminPhotoCountBadge');
            const dateInput = document.getElementById('adminFilterDate');
            const summaryEl = document.getElementById('adminFilterSummary');
            if (!container) return;

            const filterDate = dateInput ? dateInput.value : '';

            let filtered = sheetPhotoList.map((item, originalIndex) => ({ ...item, originalIndex }));
            if (filterDate) {
                filtered = filtered.filter(item => item.date === filterDate);
            }

            if (badge) badge.innerText = `${sheetPhotoList.length}장 등록됨`;
            if (summaryEl) {
                if (filterDate) summaryEl.innerText = `'${filterDate}' 날짜 사진 (${filtered.length}장)`;
                else summaryEl.innerText = `전체 날짜 사진 (${sheetPhotoList.length}장)`;
            }

            if (filtered.length === 0) {
                container.innerHTML = `<div class="text-center py-8 text-slate-400 text-xs">
                    ${filterDate ? `'${filterDate}' 날짜에 등록된 준공대지 사진이 없습니다.` : '등록된 준공대지/보관함 사진이 없습니다.'}
                </div>`;
                return;
            }

            container.innerHTML = filtered.map((item) => `
                <div class="bg-white p-3 rounded-xl border border-slate-200 flex flex-col sm:flex-row items-center gap-4">
                    <div class="w-16 h-16 bg-slate-100 rounded-lg overflow-hidden flex-shrink-0">
                        <img src="${item.imageUrl}" class="w-full h-full object-cover">
                    </div>
                    <div class="flex-1 w-full space-y-2">
                        <div class="flex flex-wrap justify-between items-center text-xs gap-2">
                            <label class="font-bold text-slate-800">촬영일:
                                <input type="date" value="${item.date || ''}" onchange="updateAdminPhotoDate(${item.originalIndex}, this.value)" class="ml-1 px-2 py-1 border border-slate-300 rounded-lg text-xs">
                            </label>
                            <span class="text-[11px] text-slate-400">#${item.originalIndex + 1}번째 사진</span>
                        </div>
                        <input type="text" value="${item.description || ''}" onchange="updateAdminPhotoDesc(${item.originalIndex}, this.value)" class="w-full px-3 py-1.5 border border-slate-300 rounded-lg text-xs focus:ring-2 focus:ring-amber-500 focus:outline-none" placeholder="작업 설명 수정">
                        <div class="flex flex-wrap gap-1.5">
                            <button onclick="moveSheetPhoto(${item.originalIndex},-1)" class="px-2.5 py-1.5 bg-slate-100 hover:bg-slate-200 text-slate-700 font-bold rounded-lg text-[11px]"><i class="fa-solid fa-arrow-up mr-1"></i>앞으로</button>
                            <button onclick="moveSheetPhoto(${item.originalIndex},1)" class="px-2.5 py-1.5 bg-slate-100 hover:bg-slate-200 text-slate-700 font-bold rounded-lg text-[11px]"><i class="fa-solid fa-arrow-down mr-1"></i>뒤로</button>
                            <label class="px-2.5 py-1.5 bg-blue-100 hover:bg-blue-200 text-blue-700 font-bold rounded-lg text-[11px] cursor-pointer">
                                <i class="fa-solid fa-image mr-1"></i>사진 교체
                                <input type="file" accept="image/*" class="hidden" onchange="replaceSheetPhoto(${item.originalIndex}, this)">
                            </label>
                        </div>
                    </div>
                    <button onclick="deleteSheetPhotoIndex(${item.originalIndex})" class="w-full sm:w-auto px-3 py-2 bg-rose-600 hover:bg-rose-700 text-white font-bold rounded-lg text-xs shadow transition flex items-center justify-center gap-1">
                        <i class="fa-solid fa-trash-can"></i> 삭제
                    </button>
                </div>
            `).join('');
        };

        window.updateAdminPhotoDesc = async function(idx, newDesc) {
            if (sheetPhotoList[idx]) {
                sheetPhotoList[idx].description = newDesc;
                await saveGlobalPublicPhotosToCloud();
                renderPrintSheets();
                showToast("사진 작업 설명이 수정되었습니다.");
            }
        };

        window.updateAdminPhotoDate = async function(idx, newDate) {
            if (!isAdminMode || !sheetPhotoList[idx]) return;
            sheetPhotoList[idx].date = newDate;
            await saveGlobalPublicPhotosToCloud();
            renderPrintSheets();
            showToast("촬영일이 수정되었습니다.");
        };

        window.moveSheetPhoto = async function(idx, direction) {
            if (!isAdminMode) return;
            const next = idx + direction;
            if (next < 0 || next >= sheetPhotoList.length) return;
            [sheetPhotoList[idx], sheetPhotoList[next]] = [sheetPhotoList[next], sheetPhotoList[idx]];
            await saveGlobalPublicPhotosToCloud();
            renderAdminPhotoEditorList();
            renderPrintSheets();
            showToast("사진 순서가 변경되었습니다.");
        };

        window.replaceSheetPhoto = function(idx, input) {
            if (!isAdminMode || !input.files || !input.files[0]) return;
            const reader = new FileReader();
            reader.onload = async event => {
                if (!sheetPhotoList[idx]) return;
                sheetPhotoList[idx].imageUrl = event.target.result;
                await saveGlobalPublicPhotosToCloud();
                renderAdminPhotoEditorList();
                renderPrintSheets();
                showToast("사진이 교체되었습니다.");
            };
            reader.readAsDataURL(input.files[0]);
        };

        window.renderAdminUserTable = function() {
            const tbody = document.getElementById('adminUserTableBody');
            const badge = document.getElementById('adminUserCountBadge');
            if (badge) badge.innerText = `${registeredUsers.length}명 등록됨`;
            if (!tbody) return;

            tbody.innerHTML = registeredUsers.map((u, i) => `
                <tr class="border-b hover:bg-slate-50">
                    <td class="p-3 font-bold text-slate-900">${u.userId}</td>
                    <td class="p-3 text-slate-700">${u.name}</td>
                    <td class="p-3 font-mono text-slate-500">${u.password}</td>
                    <td class="p-3 text-right space-x-1">
                        <button onclick="deleteAdminUser(${i})" class="px-2.5 py-1 bg-rose-100 hover:bg-rose-200 text-rose-700 font-bold rounded-lg text-[11px] transition">
                            계정 삭제
                        </button>
                    </td>
                </tr>
            `).join('');
        };

        window.deleteAdminUser = async function(idx) {
            if (!window.confirm("해당 계정을 삭제하시겠습니까?")) return;
            registeredUsers.splice(idx, 1);
            await saveGlobalUsersToCloud();
            renderAdminUserTable();
            showToast("계정이 삭제되었습니다.");
        };

        const SCHEDULE_TOTAL_COST = PROJECT.directCost;
        const defaultSchedule = cloneDefaultSchedule();
        function validSavedSchedule(value) {
            return Array.isArray(value) && value.length > 0 && value.every(item => item.id && item.group && item.start && item.end);
        }
        let storedSchedule = null;
        try { storedSchedule = JSON.parse(localStorage.getItem('smart_schedule_wbs_v3') || 'null'); } catch (e) {}
        let scheduleData = validSavedSchedule(storedSchedule) ? storedSchedule : cloneDefaultSchedule();
        const projectStart = dateAt(PROJECT.start), projectEnd = dateAt(PROJECT.end);
        const projectDays = diffDays(PROJECT.start, PROJECT.end)+1;
        const money = n => Math.round(n).toLocaleString('ko-KR')+'원';
        const ganttMonths = Array.from({length:13},(_,i)=>new Date(2026,6+i,1));
        let expandedScheduleGroup = '';
        function ganttScaleMarkup() {
            const years = `<div class="gantt-years"><div class="gantt-year" style="grid-column:span 6">2026년</div><div class="gantt-year" style="grid-column:span 7">2027년</div></div>`;
            const months = `<div class="gantt-months">${ganttMonths.map(m=>`<div class="gantt-month">${m.getMonth()+1}월</div>`).join('')}</div>`;
            return `<div class="gantt-scale">${years}${months}</div>`;
        }
        function ganttBarMarkup(item, actual) {
            const left=clamp(diffDays(PROJECT.start,item.start)/projectDays*100,0,100);
            const width=clamp((diffDays(item.start,item.end)+1)/projectDays*100,0.4,100-left);
            const actualWidth=width*clamp(actual,0,100)/100;
            return `<div class="gantt-track rounded relative overflow-hidden">
                <div class="gantt-plan-line" style="left:${left}%;width:${width}%"></div>
                <div class="gantt-actual-line" style="left:${left}%;width:${actualWidth}%"></div>
            </div>`;
        }
        function renderHomeProgressSummary(summary = summarizeSchedule(scheduleData, new Date())) {
            const today = new Date();
            const dateLabel = document.getElementById('homeTodayDate');
            if (dateLabel) dateLabel.innerText = new Intl.DateTimeFormat('ko-KR',{year:'numeric',month:'long',day:'numeric',weekday:'long'}).format(today);
            const set = (id, value) => { const el=document.getElementById(id); if(el)el.innerText=value; };
            set('homePlannedRate', summary.plan.toFixed(2)+'%');
            set('homeActualRate', summary.actual.toFixed(2)+'%');
            set('homeVarianceRate', (summary.variance>=0?'+':'')+summary.variance.toFixed(2)+'%p');
            set('homeDelayDays', summary.delayDays>0?`${summary.delayDays}일 지연`:'지연 없음');
            set('homeDelayCount', summary.delayedTasks>0?`${summary.delayedTasks}개 소공정 지연 중`:'정상 진행');
            const varianceEl=document.getElementById('homeVarianceRate');
            if(varianceEl)varianceEl.style.color=summary.variance<0?'#fecaca':'#bbf7d0';
            const delayEl=document.getElementById('homeDelayDays');
            if(delayEl)delayEl.style.color=summary.delayDays>0?'#fecaca':'#ffffff';
        }
        function renderSchedule() {
            const wrap = document.getElementById('scheduleRows'); if (!wrap) return;
            const today=new Date();
            const summary=summarizeSchedule(scheduleData,today);
            const totalCost=summary.totalCost||1;
            const groups=aggregateGroups(scheduleData,today);
            const gridClass=isAdminMode?'schedule-grid-admin':'schedule-grid-public';
            const table=document.getElementById('scheduleTable');
            table.classList.toggle('is-admin',isAdminMode);
            document.getElementById('scheduleSummaryGrid').className=`grid grid-cols-1 ${isAdminMode?'sm:grid-cols-4':'sm:grid-cols-3'} gap-3`;
            document.getElementById('scheduleHeader').innerHTML=`<div class="${gridClass} schedule-head bg-slate-900 text-white text-[10px] font-bold items-stretch">
                <div class="schedule-cell schedule-name p-2 flex items-center">WBS / 공종</div>
                ${isAdminMode?'<div class="schedule-cell p-2 flex items-center justify-end">공사비</div>':''}
                <div class="schedule-cell p-2 flex items-center justify-end">보할</div>
                <div class="schedule-cell p-2 flex items-center">시작일</div>
                <div class="schedule-cell p-2 flex items-center">종료일</div>
                <div class="schedule-cell p-2 flex items-center justify-end">예정</div>
                <div class="schedule-cell p-2 flex items-center justify-end">실시</div>
                <div class="schedule-cell p-2 flex items-center justify-end">증감</div>
                <div>${ganttScaleMarkup()}</div>
            </div>`;
            wrap.innerHTML = groups.map(group=>{
                const groupWeight=group.cost/totalCost*100;
                const groupVariance=(group.actual-group.plan)*groupWeight/100;
                const header=`<div class="${gridClass} schedule-group-row text-[10px] items-center">
                    <div class="schedule-cell schedule-name p-2 font-black text-blue-950">${group.id}. ${group.name}<span class="block text-[9px] font-medium text-blue-600">소공정 ${group.children.length}개 자동집계</span></div>
                    ${isAdminMode?`<div class="schedule-cell p-2 text-right font-bold">${money(group.cost)}</div>`:''}
                    <div class="schedule-cell p-2 text-right font-black">${groupWeight.toFixed(2)}%</div>
                    <div class="schedule-cell p-2">${group.start}</div><div class="schedule-cell p-2">${group.end}</div>
                    <div class="schedule-cell p-2 text-right">${group.plan.toFixed(1)}%</div>
                    <div class="schedule-cell p-2 text-right">${group.actual.toFixed(1)}%</div>
                    <div class="schedule-cell p-2 text-right font-bold ${groupVariance<0?'text-rose-700':'text-emerald-700'}">${groupVariance>=0?'+':''}${groupVariance.toFixed(2)}${group.delayDays?`<span class="delay-badge ml-1">${group.delayDays}일 지연</span>`:''}</div>
                    <div class="schedule-cell p-2">${ganttBarMarkup(group,group.actual)}</div>
                </div>`;
                const children=group.children.map(it=>{
                    const i=scheduleData.findIndex(x=>x.id===it.id);
                    const weight=it.cost/totalCost*100, plan=plannedRate(it,today), actual=clamp(it.actual,0,100), variance=(actual-plan)*weight/100, delay=taskDelayDays(it,today);
                    return `<div class="${gridClass} schedule-task-row border-b text-[10px] items-center ${delay>0?'bg-rose-50':'bg-white'}">
                        <div class="schedule-cell schedule-name schedule-task-name p-2 text-slate-800">${it.id} ${it.name}${delay?`<span class="delay-badge ml-1">${delay}일</span>`:''}</div>
                        ${isAdminMode?`<div class="schedule-cell p-1"><input aria-label="${it.name} 공사비" type="number" min="0" step="1000" value="${Math.round(it.cost)}" onchange="changeScheduleField(${i},'cost',this.value)" class="w-full border border-amber-300 bg-amber-50 rounded px-1 py-1 text-right font-semibold"></div>`:''}
                        <div class="schedule-cell p-2 text-right font-bold">${weight.toFixed(2)}%</div>
                        <div class="schedule-cell p-1"><input ${isAdminMode?'':'disabled'} type="date" value="${it.start}" onchange="changeScheduleField(${i},'start',this.value)" class="w-full border rounded p-1 text-[9px] disabled:bg-transparent disabled:border-0"></div>
                        <div class="schedule-cell p-1"><input ${isAdminMode?'':'disabled'} type="date" value="${it.end}" onchange="changeScheduleField(${i},'end',this.value)" class="w-full border rounded p-1 text-[9px] disabled:bg-transparent disabled:border-0"></div>
                        <div class="schedule-cell p-2 text-right">${plan.toFixed(1)}%</div>
                        <div class="schedule-cell p-1 flex items-center"><input ${isAdminMode?'':'disabled'} type="number" min="0" max="100" step="0.1" value="${actual}" onchange="changeScheduleField(${i},'actual',this.value)" class="w-full border rounded p-1 text-right disabled:bg-transparent disabled:border-0"><span>%</span></div>
                        <div class="schedule-cell p-2 text-right font-bold ${variance<0?'text-rose-600':'text-emerald-600'}">${variance>=0?'+':''}${variance.toFixed(2)}</div>
                        <div class="schedule-cell p-2">${ganttBarMarkup(it,actual)}</div>
                    </div>`;
                }).join('');
                return header+children;
            }).join('');
            document.getElementById('scheduleTotalCost').innerText=money(totalCost);
            document.getElementById('schedulePlanTotal').innerText=summary.plan.toFixed(2)+'%';
            document.getElementById('scheduleActualTotal').innerText=summary.actual.toFixed(2)+'%';
            const v=document.getElementById('scheduleVariance'); v.innerText=(summary.variance>=0?'+':'')+summary.variance.toFixed(2)+'%p'+(summary.delayDays?` · ${summary.delayDays}일 지연`:''); v.className='block text-sm mt-1 '+(summary.variance<0?'text-rose-600':'text-emerald-600');
            renderHomeProgressSummary(summary);
            renderMobileSchedule(groups,totalCost,today);
            renderMonthlyProgress(totalCost);
        }
        function renderMobileSchedule(groups,totalCost,today) {
            const mobile=document.getElementById('scheduleMobileOverview'); if(!mobile)return;
            const monthHead=ganttMonths.map(m=>`<span class="mobile-gantt-month text-center">${m.getMonth()+1}</span>`).join('');
            const rows=groups.map(group=>{
                const groupWeight=group.cost/totalCost*100;
                const left=clamp(diffDays(PROJECT.start,group.start)/projectDays*100,0,100);
                const width=clamp((diffDays(group.start,group.end)+1)/projectDays*100,0.4,100-left);
                const actualWidth=width*clamp(group.actual,0,100)/100;
                const open=expandedScheduleGroup===group.group;
                const children=open?group.children.map(it=>{
                    const index=scheduleData.findIndex(x=>x.id===it.id);
                    const weight=it.cost/totalCost*100, plan=plannedRate(it,today), actual=clamp(it.actual,0,100), delay=taskDelayDays(it,today);
                    const adminFields=isAdminMode?`<div class="grid grid-cols-2 gap-2 mt-2">
                        <label class="text-[9px] text-slate-500">시작일<input type="date" value="${it.start}" onchange="changeScheduleField(${index},'start',this.value)" class="block w-full mt-1 border rounded p-1.5 text-[10px] bg-white"></label>
                        <label class="text-[9px] text-slate-500">종료일<input type="date" value="${it.end}" onchange="changeScheduleField(${index},'end',this.value)" class="block w-full mt-1 border rounded p-1.5 text-[10px] bg-white"></label>
                        <label class="text-[9px] text-slate-500">공사비<input type="number" min="0" step="1000" value="${Math.round(it.cost)}" onchange="changeScheduleField(${index},'cost',this.value)" class="block w-full mt-1 border border-amber-300 rounded p-1.5 text-[10px] text-right bg-amber-50"></label>
                        <label class="text-[9px] text-slate-500">실제공정률<input type="number" min="0" max="100" step="0.1" value="${actual}" onchange="changeScheduleField(${index},'actual',this.value)" class="block w-full mt-1 border rounded p-1.5 text-[10px] text-right bg-white"></label>
                    </div>`:'';
                    return `<div class="rounded-xl border ${delay?'border-rose-200 bg-rose-50':'border-slate-200 bg-white'} p-3">
                        <div class="flex justify-between gap-2"><b class="text-[10px] text-slate-800">${it.id} ${it.name}</b>${delay?`<span class="delay-badge">${delay}일 지연</span>`:''}</div>
                        <div class="grid grid-cols-4 gap-1 mt-2 text-center text-[9px]">
                            <div><span class="block text-slate-400">기간</span><b>${diffDays(it.start,it.end)+1}일</b></div>
                            <div><span class="block text-slate-400">보할</span><b>${weight.toFixed(2)}%</b></div>
                            <div><span class="block text-slate-400">예정</span><b class="text-blue-600">${plan.toFixed(1)}%</b></div>
                            <div><span class="block text-slate-400">실제</span><b class="text-rose-600">${actual.toFixed(1)}%</b></div>
                        </div>
                        <div class="mt-2 text-[9px] text-slate-500 flex justify-between"><span>${it.start}</span><span>${it.end}</span></div>${adminFields}
                    </div>`;
                }).join(''):'';
                return `<div class="mobile-schedule-row ${open?'is-open':''}">
                    <button type="button" onclick='toggleMobileScheduleGroup(${JSON.stringify(group.group)})' aria-expanded="${open}" class="mobile-schedule-name p-2 text-left font-black text-slate-800 flex items-center gap-1">
                        <i class="fa-solid fa-chevron-${open?'down':'right'} text-[7px] text-blue-500"></i><span>${group.id}. ${group.name}</span>
                    </button>
                    <button type="button" onclick='toggleMobileScheduleGroup(${JSON.stringify(group.group)})' aria-label="${group.name} 상세 보기" class="p-2">
                        <div class="mobile-schedule-track h-7 rounded relative overflow-hidden">
                            <div class="gantt-plan-line" style="left:${left}%;width:${width}%"></div>
                            <div class="gantt-actual-line" style="left:${left}%;width:${actualWidth}%"></div>
                        </div>
                    </button>
                    ${open?`<div class="mobile-schedule-detail px-3 pb-3 space-y-2">
                        <div class="grid grid-cols-4 gap-1 rounded-xl border border-blue-200 bg-blue-50 p-2 text-center text-[9px]">
                            <div><span class="block text-slate-400">소공정</span><b>${group.children.length}개</b></div>
                            <div><span class="block text-slate-400">보할</span><b>${groupWeight.toFixed(2)}%</b></div>
                            <div><span class="block text-slate-400">예정</span><b class="text-blue-600">${group.plan.toFixed(1)}%</b></div>
                            <div><span class="block text-slate-400">실제</span><b class="text-rose-600">${group.actual.toFixed(1)}%</b></div>
                        </div>${children}
                    </div>`:''}
                </div>`;
            }).join('');
            mobile.innerHTML=`<div class="p-3 border-b bg-slate-900 text-white">
                <div class="flex justify-between items-center"><b class="text-[11px]">모바일 전체 공정</b><span class="text-[8px] text-slate-300">대공종을 누르면 소공정이 열립니다</span></div>
                <div class="grid grid-cols-[104px_1fr] mt-2 items-end"><span class="text-[8px] text-slate-400">대공종</span><div><div class="grid grid-cols-2 text-[7px] text-center text-slate-300"><span>2026년</span><span>2027년</span></div><div class="grid mt-1" style="grid-template-columns:repeat(13,minmax(0,1fr))">${monthHead}</div></div></div>
            </div>${rows}`;
        }
        window.toggleMobileScheduleGroup = function(groupName) {
            expandedScheduleGroup=expandedScheduleGroup===groupName?'':groupName;
            const today=new Date(), summary=summarizeSchedule(scheduleData,today);
            renderMobileSchedule(aggregateGroups(scheduleData,today),summary.totalCost||1,today);
        };
        function renderMonthlyProgress(totalCost) {
            const months=[]; let d=new Date(2026,6,1);
            while(d<=projectEnd){months.push(new Date(d)); d.setMonth(d.getMonth()+1);}
            let cumulative=0;
            const cells=months.map((m,monthIndex)=>{
                const ms=new Date(m.getFullYear(),m.getMonth(),1), me=new Date(m.getFullYear(),m.getMonth()+1,0);
                let rate=0;
                scheduleData.forEach(it=>{
                    const s=dateAt(it.start),e=dateAt(it.end), from=Math.max(s,ms),to=Math.min(e,me);
                    if(from<=to) rate+=((to-from)/86400000+1)/((e-s)/86400000+1)*(it.cost/totalCost*100);
                });
                cumulative+=rate;
                return `<button onclick="showMonthlyGantt(${m.getFullYear()},${m.getMonth()})" class="p-3 border rounded-xl text-center hover:border-blue-500 hover:bg-blue-50 transition"><b>${m.getFullYear()}년 ${m.getMonth()+1}월</b><br><span class="text-blue-600">${rate.toFixed(1)}%</span><br><span class="text-slate-500">누계 ${Math.min(100,cumulative).toFixed(1)}%</span></button>`;
            }).join('');
            document.getElementById('monthlyProgressTable').innerHTML=`<div class="p-4 border-b"><b class="text-sm">월별 예정 공정률</b><p class="text-[10px] text-slate-500 mt-1">월을 누르면 한 장짜리 상세 간트표가 열립니다.</p></div><div class="grid grid-cols-2 sm:grid-cols-4 lg:grid-cols-7 gap-2 p-3 text-[10px]">${cells}</div>`;
        }
        window.showMonthlyGantt = function(year, month) {
            const detail=document.getElementById('monthlyGanttDetail');
            const first=new Date(year,month,1), last=new Date(year,month+1,0), days=last.getDate();
            const visibleTasks=scheduleData.filter(it=>dateAt(it.start)<=last&&dateAt(it.end)>=first);
            const rows=visibleTasks.map(it=>{
                const s=dateAt(it.start), e=dateAt(it.end), from=new Date(Math.max(s,first)), to=new Date(Math.min(e,last));
                const visible=from<=to;
                const left=visible?diffDays(first,from)/days*100:0;
                const width=visible?(diffDays(from,to)+1)/days*100:0;
                const actualWidth=width*clamp(it.actual,0,100)/100;
                return `<div class="monthly-gantt-grid grid grid-cols-[150px_1fr] border-b text-[10px]"><div class="p-2 font-bold border-r">${it.id} ${it.name}</div><div class="relative p-2 bg-slate-50"><div class="h-7 relative">${visible?`<div class="gantt-plan-line" style="left:${left}%;width:${width}%"></div><div class="gantt-actual-line" style="left:${left}%;width:${actualWidth}%"></div>`:''}</div></div></div>`;
            }).join('');
            const dayHead=Array.from({length:days},(_,i)=>`<span class="text-center ${[0,6].includes(new Date(year,month,i+1).getDay())?'text-rose-500':''}">${i+1}</span>`).join('');
            detail.innerHTML=`<div class="p-4 border-b flex items-center justify-between"><div><p class="text-[10px] font-bold text-blue-600">MONTHLY DETAIL GANTT</p><h3 class="text-lg font-black">${year}년 ${month+1}월 월별 상세 공정표</h3></div><button onclick="printMonthlyGantt()" class="px-3 py-2 bg-slate-900 text-white rounded-lg text-xs font-bold">한 장 인쇄</button></div><div class="monthly-gantt-grid grid grid-cols-[150px_1fr] bg-slate-900 text-white text-[9px]"><div class="p-2 font-bold">공종</div><div class="monthly-gantt-days grid p-2" style="grid-template-columns:repeat(${days},1fr)">${dayHead}</div></div>${rows}`;
            detail.classList.remove('hidden');
            detail.scrollIntoView({behavior:'smooth',block:'start'});
        };
        window.printMonthlyGantt=function(){
            const s=document.getElementById('tabScheduleView'),style=document.createElement('style');
            style.id='monthlyPageStyle';style.textContent='@page{size:A4 landscape;margin:8mm}';document.head.appendChild(style);
            s.classList.add('monthly-printing');window.print();
            setTimeout(()=>{s.classList.remove('monthly-printing');style.remove();},500);
        };
        window.changeScheduleField = function(index,key,value) {
            if(!isAdminMode) return;
            scheduleData[index][key]=key==='actual'?clamp(Number(value),0,100):key==='cost'?Math.max(0,Math.round(Number(value)||0)):value;
            if(key==='start'&&dateAt(scheduleData[index].end)<dateAt(value))scheduleData[index].end=value;
            if(key==='end'&&dateAt(value)<dateAt(scheduleData[index].start))scheduleData[index].start=value;
            localStorage.setItem('smart_schedule_wbs_v3',JSON.stringify(scheduleData)); saveConstructionScheduleCloud(); renderSchedule(); renderSiteSchedules(); showToast('소공정이 저장되고 대공종이 자동 재계산되었습니다.');
        };
        window.resetSchedule = function() { if(!isAdminMode)return; scheduleData=cloneDefaultSchedule(); localStorage.removeItem('smart_schedule_wbs_v3'); saveConstructionScheduleCloud(); renderSchedule(); renderSiteSchedules(); showToast('계약내역 기준 세부 공정표로 복원되었습니다.'); };
        window.printSchedule = function(){
            const s=document.getElementById('tabScheduleView'),style=document.createElement('style');
            style.id='schedulePageStyle';style.textContent='@page{size:A4 landscape;margin:8mm}';document.head.appendChild(style);
            s.classList.add('schedule-printing');window.print();
            setTimeout(()=>{s.classList.remove('schedule-printing');style.remove();},500);
        };

        const defaultSiteSchedules=[
            {date:'2026-07-27',time:'08:00',category:'회의',title:'착공 및 현장 운영회의',location:'현장사무실',manager:'현장소장',important:true,done:false},
            {date:'2026-08-03',time:'08:00',category:'자재반입',title:'가설자재 반입',location:'현장 정문',manager:'공사팀',important:false,done:false}
        ];
        let siteSchedules=JSON.parse(localStorage.getItem('smart_site_schedules_v1')||'null')||defaultSiteSchedules;
        let homeCalendarDate=new Date(new Date().getFullYear(),new Date().getMonth(),1);
        function renderHomeCalendar(){
            const title=document.getElementById('homeCalendarTitle'), grid=document.getElementById('homeCalendarGrid'); if(!title||!grid)return;
            const y=homeCalendarDate.getFullYear(),m=homeCalendarDate.getMonth(),firstDay=new Date(y,m,1).getDay(),days=new Date(y,m+1,0).getDate();
            title.innerText=`${y}년 ${m+1}월`;
            const cells=[];
            for(let i=0;i<firstDay;i++)cells.push('<div class="calendar-day is-other"></div>');
            for(let d=1;d<=days;d++){
                const key=`${y}-${String(m+1).padStart(2,'0')}-${String(d).padStart(2,'0')}`;
                const date=new Date(y,m,d), day=date.getDay(), today=getLocalDateString(), events=siteSchedules.filter(x=>x.date===key).map(x=>({...x,kind:'manual'}));
                scheduleData.forEach(item=>{
                    if(item.start===key)events.push({time:'착수',title:item.name,category:'시공',kind:'schedule'});
                    if(item.end===key)events.push({time:'완료',title:item.name,category:'검사·검측',kind:'schedule'});
                    const delay=taskDelayDays(item,new Date());
                    if(key===today&&delay>0)events.push({time:`${delay}일`,title:`${item.name} 지연`,category:'지연',kind:'delay'});
                });
                const shown=events.slice(0,4), extra=events.length-shown.length;
                const classes=['calendar-day',day===0?'is-sunday':'',day===6?'is-saturday':'',key===today?'is-today':''].filter(Boolean).join(' ');
                cells.push(`<div class="${classes}"><b class="calendar-date-number text-[11px]">${d}</b>${shown.map(x=>`<span class="calendar-event ${x.done?'opacity-50 line-through':''} ${x.kind==='delay'?'is-delayed':''}" data-category="${x.category||'기타'}" title="${x.title}">${x.time} ${x.title}</span>`).join('')}${extra>0?`<span class="block mt-1 text-[9px] font-bold text-slate-500">+${extra}개 일정</span>`:''}</div>`);
            }
            grid.innerHTML=cells.join('');
        }
        window.moveHomeCalendar=function(delta){homeCalendarDate=new Date(homeCalendarDate.getFullYear(),homeCalendarDate.getMonth()+delta,1);renderHomeCalendar();};
        function renderSiteSchedules(){
            const home=document.getElementById('homeScheduleList'),admin=document.getElementById('adminScheduleList'); if(!home)return;
            const today=getLocalDateString(), upcoming=siteSchedules.filter(x=>!x.done&&x.date>=today).sort((a,b)=>(a.date+a.time).localeCompare(b.date+b.time)).slice(0,5);
            home.innerHTML=upcoming.length?upcoming.map(x=>`<div class="flex items-center gap-3 p-3 rounded-xl ${x.date===today?'bg-blue-50 border-blue-200':'bg-slate-50'} border">
                <div class="w-14 text-center"><b class="block text-xs ${x.date===today?'text-blue-600':'text-slate-700'}">${x.date===today?'오늘':x.date.slice(5)}</b><span class="text-[10px] text-slate-500">${x.time}</span></div>
                <div class="min-w-0 flex-1"><b class="text-sm text-slate-900">${x.title}</b><p class="text-[10px] text-slate-500 mt-0.5">${x.category} · ${x.location||'위치 미정'} · ${x.manager||'담당 미정'}</p></div>${x.important?'<span class="text-[10px] bg-rose-100 text-rose-700 px-2 py-1 rounded-full font-bold">중요</span>':''}
            </div>`).join(''):'<div class="text-center text-xs text-slate-400 py-8">등록된 향후 주요 일정이 없습니다.</div>';
            renderHomeCalendar();
            if(admin) admin.innerHTML=siteSchedules.length?siteSchedules.map((x,i)=>`<div class="grid grid-cols-2 sm:grid-cols-[125px_85px_105px_1fr_120px_90px] gap-2 items-center p-3 bg-slate-50 rounded-xl border">
                <input type="date" value="${x.date}" onchange="editSiteSchedule(${i},'date',this.value)" class="border rounded-lg p-2 text-xs">
                <input type="time" value="${x.time}" onchange="editSiteSchedule(${i},'time',this.value)" class="border rounded-lg p-2 text-xs">
                <select onchange="editSiteSchedule(${i},'category',this.value)" class="border rounded-lg p-2 text-xs">${['자재반입','시공','검사·검측','회의','장비','안전','기타'].map(v=>`<option ${v===x.category?'selected':''}>${v}</option>`).join('')}</select>
                <input value="${x.title}" onchange="editSiteSchedule(${i},'title',this.value)" placeholder="일정명" class="border rounded-lg p-2 text-xs">
                <input value="${x.manager||''}" onchange="editSiteSchedule(${i},'manager',this.value)" placeholder="담당자/업체" class="border rounded-lg p-2 text-xs">
                <div class="flex gap-1"><button onclick="toggleSiteSchedule(${i})" class="flex-1 p-2 rounded-lg ${x.done?'bg-emerald-100 text-emerald-700':'bg-white border'} text-[10px] font-bold">${x.done?'완료':'미완료'}</button><button onclick="deleteSiteSchedule(${i})" class="p-2 text-rose-600"><i class="fa-solid fa-trash"></i></button></div>
            </div>`).join(''):'<p class="text-center text-xs text-slate-400 py-5">등록된 일정이 없습니다.</p>';
        }
        function saveSiteSchedules(){localStorage.setItem('smart_site_schedules_v1',JSON.stringify(siteSchedules));saveConstructionScheduleCloud();renderSiteSchedules();}
        window.openScheduleManager=function(){if(!isAdminMode){handleAdminModeToggle();return;}switchTab('tabAdminView');setTimeout(()=>document.getElementById('adminScheduleManager').scrollIntoView({behavior:'smooth'}),50);};
        window.addSiteSchedule=function(){siteSchedules.push({date:getLocalDateString(),time:'08:00',category:'시공',title:'새 주요 일정',location:'현장',manager:'',important:false,done:false});saveSiteSchedules();};
        window.editSiteSchedule=function(i,k,v){siteSchedules[i][k]=v;saveSiteSchedules();};
        window.toggleSiteSchedule=function(i){siteSchedules[i].done=!siteSchedules[i].done;saveSiteSchedules();};
        window.deleteSiteSchedule=function(i){if(confirm('이 일정을 삭제하시겠습니까?')){siteSchedules.splice(i,1);saveSiteSchedules();}};

        function setupConstructionScheduleSync(){
            if(!db)return;
            const safeAppId=appId.replace(/[^a-zA-Z0-9_-]/g,'_');
            const ref=doc(db,'artifacts',`${safeAppId}_public_data`,'data','construction_schedule_v1');
            onSnapshot(ref,snap=>{
                if(!snap.exists())return;
                const data=snap.data();
                if(validSavedSchedule(data.scheduleData)){scheduleData=data.scheduleData;localStorage.setItem('smart_schedule_wbs_v3',JSON.stringify(scheduleData));}
                if(Array.isArray(data.siteSchedules)){siteSchedules=data.siteSchedules;localStorage.setItem('smart_site_schedules_v1',JSON.stringify(siteSchedules));}
                renderSchedule();renderSiteSchedules();
            },()=>{});
        }
        async function saveConstructionScheduleCloud(){
            if(!db)return true;
            try{
                const safeAppId=appId.replace(/[^a-zA-Z0-9_-]/g,'_');
                const ref=doc(db,'artifacts',`${safeAppId}_public_data`,'data','construction_schedule_v1');
                await setDoc(ref,{scheduleData,siteSchedules,scheduleVersion:PROJECT.scheduleVersion,savedAt:new Date().toISOString()});
                return true;
            }catch(e){showToast('⚠️ 공정 일정 클라우드 저장에 실패했습니다.');return false;}
        }

        async function loadGangneungWeather(){
            const now=new Date();
            try{
                const url='https://api.open-meteo.com/v1/forecast?latitude=37.7519&longitude=128.8761&current=temperature_2m,relative_humidity_2m,weather_code,wind_speed_10m&hourly=precipitation_probability&timezone=Asia%2FSeoul&forecast_days=1';
                const r=await fetch(url); if(!r.ok)throw new Error(); const data=await r.json(),c=data.current;
                const names={0:'맑음',1:'대체로 맑음',2:'부분 흐림',3:'흐림',45:'안개',48:'안개',51:'이슬비',53:'이슬비',55:'강한 이슬비',61:'비',63:'비',65:'강한 비',71:'눈',73:'눈',75:'폭설',80:'소나기',81:'소나기',82:'강한 소나기',95:'뇌우'};
                const rain=Math.max(...(data.hourly?.precipitation_probability||[0])),temp=Number(c.temperature_2m),hum=Number(c.relative_humidity_2m),wind=Number(c.wind_speed_10m)/3.6;
                document.getElementById('weatherSummary').innerText=`${names[c.weather_code]||'기상 확인'} · ${temp.toFixed(1)}℃`;
                document.getElementById('weatherRain').innerText=rain+'%';document.getElementById('weatherHumidity').innerText=hum+'%';document.getElementById('weatherWind').innerText=wind.toFixed(1)+'m/s';
                const notes=[];if(rain>=40)notes.push('콘크리트 타설·방수·도장 작업 주의');if(wind>=8)notes.push('고소작업·크레인·비계 작업 주의');if(temp>=33)notes.push('폭염 휴식·수분 섭취 및 온열질환 주의');if(temp<=0)notes.push('결빙·콘크리트 양생·보온 주의');if(hum>=80)notes.push('미끄럼·전기작업·도장 건조상태 주의');
                document.getElementById('weatherAdvice').innerText=notes.join(' · ')||'특이 기상사항 없음. 일반 안전수칙을 준수하세요.';
            }catch(e){document.getElementById('weatherSummary').innerText='기상정보 확인 중';}
        }
        window.openDrawing = function(path,title) {
            const card=document.getElementById('drawingViewerCard'), frame=document.getElementById('drawingFrame'), link=document.getElementById('drawingOpenNew');
            const activeDrawingSection = ['tabDrawingArchitectureView','tabDrawingStructureView']
                .map(id => document.getElementById(id))
                .find(el => el && !el.classList.contains('hidden'));
            if (activeDrawingSection && card.parentElement !== activeDrawingSection) activeDrawingSection.appendChild(card);
            document.getElementById('drawingViewerTitle').innerText=title; frame.src=path+'#view=FitH'; link.href=path; card.classList.remove('hidden'); card.scrollIntoView({behavior:'smooth'});
        };
        window.openDrawingFromTab = function(path,title) { selectSubTab('drawing','tabDrawingOverviewView'); setTimeout(()=>openDrawing(path,title),50); };
        const scheduleErrors=validateSchedule(scheduleData,SCHEDULE_TOTAL_COST);
        if(scheduleErrors.length)console.warn('Schedule validation',scheduleErrors);
        renderSchedule();
